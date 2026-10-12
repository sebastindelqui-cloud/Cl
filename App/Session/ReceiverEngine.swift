import Foundation
import Network
import AVFoundation
import DualSoundCore

/// Motor del receptor: anuncia el dispositivo por Bonjour, acepta la conexión
/// del emisor, sincroniza el reloj y reproduce el audio recibido en la salida
/// local (el parlante Bluetooth conectado a *este* dispositivo).
///
/// Todo el estado vive en `queue`. La interfaz lo observa mediante `onChange`.
final class ReceiverEngine {
    enum ConnectionState: Equatable {
        case stopped
        case advertising
        case connected(hostName: String)
        case failed(String)
    }

    struct Snapshot {
        var state: ConnectionState = .stopped
        var clockSynchronized = false
        var clockRoundTrip: Double?
        var clockOffset: Double?
        var output = SyncedAudioOutput.Snapshot()
        var volume: Float = 1
        var delay: Double = 0
        var lastEvent: String?
    }

    let queue = DispatchQueue(label: "dualsound.receiver", qos: .userInitiated)
    private let output = SyncedAudioOutput(format: .standard)

    var onChange: ((Snapshot) -> Void)?

    private var name: String
    private var listener: NWListener?
    private var connection: FramedConnection?
    private var connectionGeneration = 0
    private var state: ConnectionState = .stopped
    private var clock = ClockSynchronizer()
    private var nextPingID: UInt32 = 0
    private var pingTimer: DispatchSourceTimer?
    private var statusTimer: DispatchSourceTimer?
    private var timeline: PlaybackTimeline?
    private var volume: Float = 1
    private var delay: Double = 0
    private var lastEvent: String?

    init(name: String) {
        self.name = name
    }

    deinit {
        pingTimer?.cancel()
        statusTimer?.cancel()
        listener?.cancel()
        connection?.cancel()
    }

    // MARK: Anuncio en la red

    func start() {
        queue.async { self.startListening() }
    }

    func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            self.dropConnection(event: nil)
            self.state = .stopped
            self.notify()
        }
    }

    func rename(_ newName: String) {
        queue.async {
            guard newName != self.name, !newName.isEmpty else { return }
            self.name = newName
            self.listener?.service = NWListener.Service(name: newName, type: ProtocolConstants.bonjourServiceType)
        }
    }

    private func startListening() {
        guard listener == nil else { return }
        do {
            let listener = try NWListener(using: DualSoundNetwork.parameters())
            listener.service = NWListener.Service(name: name, type: ProtocolConstants.bonjourServiceType)
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    if case .connected = self.state {} else { self.state = .advertising }
                case .failed(let error), .waiting(let error):
                    self.state = .failed(DualSoundNetwork.describe(error))
                    self.listener?.cancel()
                    self.listener = nil
                    // Reintenta: suele deberse a que el WiFi aún no estaba listo.
                    self.queue.asyncAfter(deadline: .now() + 3) { self.startListening() }
                default:
                    break
                }
                self.notify()
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            state = .failed("No se pudo anunciar el receptor: \(error.localizedDescription)")
            notify()
        }
    }

    /// Acepta al emisor. Si ya había uno, el nuevo lo reemplaza (por ejemplo,
    /// cuando el emisor se reconecta tras un corte).
    private func accept(_ nwConnection: NWConnection) {
        dropConnection(event: nil)
        connectionGeneration += 1
        let generation = connectionGeneration
        let framed = FramedConnection(connection: nwConnection, queue: queue)
        framed.onMessage = { [weak self] message, arrival in
            guard let self, generation == self.connectionGeneration else { return }
            self.handle(message, arrival: arrival)
        }
        framed.onClosed = { [weak self] reason in
            guard let self, generation == self.connectionGeneration else { return }
            self.dropConnection(event: reason ?? "El emisor se desconectó.")
            if self.listener != nil { self.state = .advertising }
            self.notify()
        }
        connection = framed
        framed.start()
    }

    private func dropConnection(event: String?) {
        connectionGeneration += 1
        connection?.cancel()
        connection = nil
        pingTimer?.cancel()
        pingTimer = nil
        statusTimer?.cancel()
        statusTimer = nil
        clock.reset()
        timeline = nil
        output.stop()
        output.setClockOffset(nil)
        if let event { lastEvent = event }
    }

    // MARK: Protocolo

    private func handle(_ message: WireMessage, arrival: Double) {
        switch message {
        case .hello(let hello):
            guard hello.protocolVersion == ProtocolConstants.version, hello.format == output.format else {
                lastEvent = "El emisor usa otra versión de DualSound. Actualiza ambas apps."
                dropConnection(event: nil)
                notify()
                return
            }
            connection?.send(.helloAck(ReceiverHello(receiverName: name)))
            state = .connected(hostName: hello.hostName)
            lastEvent = "Conectado a \(hello.hostName)."
            startClockSync()
            startStatusReports()
        case let .clockPong(_, t0, t1, t2):
            clock.add(ClockSample(t0: t0, t1: t1, t2: t2, t3: arrival))
            output.setClockOffset(clock.offset)
        case .play(let tl):
            timeline = tl
            output.start(timeline: tl)
        case .audio(let chunk):
            output.enqueue(chunk)
        case .stop(let streamID):
            if timeline?.streamID == streamID {
                timeline = nil
                output.stop()
            }
        case .setVolume(let v):
            volume = v
            output.setVolume(v)
        case .setDelay(let d):
            delay = d
            output.setUserDelay(d)
        case .helloAck, .clockPing, .status:
            break // Solo los envía un receptor.
        }
        // El audio llega 50 veces por segundo; la interfaz se refresca con
        // el informe periódico en lugar de con cada bloque.
        if case .audio = message { return }
        notify()
    }

    /// Ráfaga inicial de pings (rápida convergencia) y luego uno por segundo
    /// para seguir la deriva de los relojes.
    private func startClockSync() {
        clock.reset()
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        var sent = 0
        timer.schedule(deadline: .now(), repeating: .milliseconds(50))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.sendPing()
            sent += 1
            if sent == 10 {
                timer.schedule(deadline: .now() + 1, repeating: 1)
            }
        }
        timer.resume()
        pingTimer = timer
    }

    private func sendPing() {
        nextPingID &+= 1
        connection?.send(.clockPing(id: nextPingID, t0: HostClock.now()))
    }

    private func startStatusReports() {
        statusTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.connection?.send(.status(self.makeStatus()))
            self.notify()
        }
        timer.resume()
        statusTimer = timer
    }

    private func makeStatus() -> ReceiverStatus {
        let o = output.snapshot
        let outputName = AVAudioSession.sharedInstance().currentRoute.outputs
            .map(\.portName).joined(separator: ", ")
        return ReceiverStatus(isPlaying: o.isPlaying,
                              clockSynchronized: clock.isSynchronized,
                              clockRoundTrip: Float(clock.bestRoundTrip ?? 0),
                              bufferedSeconds: Float(o.bufferedSeconds),
                              syncError: Float(o.syncError ?? .nan),
                              outputLatency: Float(o.outputLatency),
                              outputName: outputName.isEmpty ? "Sin salida" : outputName,
                              droppedChunks: UInt32(clamping: o.droppedChunks))
    }

    private func notify() {
        var s = Snapshot()
        s.state = state
        s.clockSynchronized = clock.isSynchronized
        s.clockRoundTrip = clock.bestRoundTrip
        s.clockOffset = clock.offset
        s.output = output.snapshot
        s.volume = volume
        s.delay = delay
        s.lastEvent = lastEvent
        onChange?(s)
    }
}
