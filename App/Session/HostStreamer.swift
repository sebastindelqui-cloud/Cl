import Foundation
import Network
import DualSoundCore

/// Motor del emisor. Lee la fuente de audio, la reparte a la salida local y a
/// todos los receptores con la misma línea de tiempo, y gestiona
/// reproducir/pausar/reanudar.
///
/// Todo el estado vive en `queue`. La interfaz lo observa mediante `onChange`.
final class HostStreamer {
    struct ReceiverInfo: Identifiable, Equatable {
        let id: UUID
        let name: String
        let state: RemoteReceiver.State
        let status: ReceiverStatus?
        let volume: Float
        let delay: Double
    }

    struct Snapshot {
        var sourceName: String?
        var isPlaying = false
        var positionSeconds: Double = 0
        var durationSeconds: Double?
        var receivers: [ReceiverInfo] = []
        var local = SyncedAudioOutput.Snapshot()
        var localVolume: Float = 1
        var localDelay: Double = 0
        var playsLocally = true
        var error: String?
    }

    let queue = DispatchQueue(label: "dualsound.host", qos: .userInitiated)
    let format = StreamFormat.standard
    let localOutput: SyncedAudioOutput

    /// Se llama en `queue` cada vez que algo cambia.
    var onChange: ((Snapshot) -> Void)?

    private let hostName: String
    private var source: AudioSource?
    private var timeline: PlaybackTimeline?
    private var nextStreamID: UInt32 = 1
    /// Próximo cuadro a leer y enviar.
    private var sendHead: Int64 = 0
    /// Posición donde se pausó (o 0 al cargar una pista).
    private var resumeFrame: Int64 = 0
    /// Último cuadro de la pista, cuando ya se leyó todo el archivo.
    private var endFrame: Int64?
    private var history: ChunkHistory
    private var receivers: [RemoteReceiver] = []
    private var pumpTimer: DispatchSourceTimer?
    private var statusTimer: DispatchSourceTimer?
    private var localVolume: Float = 1
    private var localDelay: Double = 0
    private var playsLocally = true
    private var lastError: String?

    init(hostName: String) {
        self.hostName = hostName
        localOutput = SyncedAudioOutput(format: format)
        localOutput.setClockOffset(0)   // El emisor es la referencia de reloj.
        history = ChunkHistory(maxFrames: format.frames(forSeconds: ProtocolConstants.historyDuration))

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.notify() }
        timer.resume()
        statusTimer = timer
    }

    deinit {
        pumpTimer?.cancel()
        statusTimer?.cancel()
        receivers.forEach { $0.remove() }
    }

    // MARK: Fuente

    func load(_ newSource: AudioSource) {
        queue.async {
            self.stopStreaming()
            self.source = newSource
            self.resumeFrame = 0
            self.lastError = nil
            self.notify()
        }
    }

    // MARK: Transporte

    func play() {
        queue.async { self.startStreaming() }
    }

    func pause() {
        queue.async {
            guard let timeline = self.timeline else { return }
            let now = HostClock.now()
            let position = Int64(timeline.frame(atHostTime: now).rounded(.down))
            self.resumeFrame = max(timeline.anchorFrame, min(position, self.endFrame ?? position))
            self.stopStreaming()
            self.notify()
        }
    }

    private func startStreaming() {
        guard timeline == nil else { return }
        guard let source else {
            lastError = "Primero elige una canción o la pista de calibración."
            notify()
            return
        }
        if let total = source.totalFrames, resumeFrame >= total { resumeFrame = 0 }
        let streamID = nextStreamID
        nextStreamID &+= 1
        let tl = PlaybackTimeline(streamID: streamID, anchorFrame: resumeFrame,
                                  anchorHostTime: HostClock.now() + ProtocolConstants.startLeadTime,
                                  sampleRate: format.sampleRate)
        timeline = tl
        sendHead = resumeFrame
        endFrame = nil
        history.removeAll()
        lastError = nil

        localOutput.start(timeline: tl)
        broadcast(.play(tl))

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.pump() }
        timer.resume()
        pumpTimer = timer
        notify()
    }

    private func stopStreaming() {
        pumpTimer?.cancel()
        pumpTimer = nil
        if let tl = timeline { broadcast(.stop(streamID: tl.streamID)) }
        timeline = nil
        history.removeAll()
        localOutput.stop()
    }

    /// Lee y envía audio hasta mantener `sendAheadTime` segundos por delante.
    private func pump() {
        guard let tl = timeline, let source else { return }
        let now = HostClock.now()

        if let end = endFrame {
            // Terminó la pista: esperar a que suene el final y detenerse.
            if now > tl.hostTime(forFrame: end) + 0.3 {
                resumeFrame = 0
                stopStreaming()
                notify()
            }
            return
        }

        let horizon = now + ProtocolConstants.sendAheadTime
        while tl.hostTime(forFrame: sendHead) < horizon {
            let samples: [Int16]?
            do {
                samples = try source.read(from: sendHead, count: ProtocolConstants.chunkFrames)
            } catch {
                lastError = error.localizedDescription
                samples = nil
            }
            guard let samples, !samples.isEmpty else {
                endFrame = sendHead
                return
            }
            let chunk = AudioChunk(streamID: tl.streamID, startFrame: sendHead,
                                   samples: samples, channels: format.channels)
            sendHead = chunk.endFrame
            history.append(chunk)
            localOutput.enqueue(chunk)
            broadcast(.audio(chunk))
        }
    }

    private func broadcast(_ message: WireMessage) {
        for receiver in receivers { receiver.send(message) }
    }

    // MARK: Receptores

    func connect(to discovered: DiscoveredReceiver) {
        queue.async {
            guard !self.receivers.contains(where: { $0.name == discovered.name }) else { return }
            let receiver = RemoteReceiver(name: discovered.name, endpoint: discovered.endpoint,
                                          hostHello: HostHello(hostName: self.hostName, format: self.format),
                                          queue: self.queue)
            receiver.onReady = { [weak self] r in self?.receiverDidBecomeReady(r) }
            receiver.onUpdate = { [weak self] in self?.notify() }
            self.receivers.append(receiver)
            receiver.start()
            self.notify()
        }
    }

    func removeReceiver(id: UUID) {
        queue.async {
            guard let index = self.receivers.firstIndex(where: { $0.id == id }) else { return }
            let receiver = self.receivers.remove(at: index)
            receiver.send(.stop(streamID: self.timeline?.streamID ?? 0))
            receiver.remove()
            self.notify()
        }
    }

    /// Un receptor (re)conectado se suma a la reproducción en curso con el
    /// audio reciente que aún no ha sonado.
    private func receiverDidBecomeReady(_ receiver: RemoteReceiver) {
        guard let tl = timeline else { return }
        receiver.send(.play(tl))
        let playingNow = Int64(tl.frame(atHostTime: HostClock.now()).rounded(.down))
        for chunk in history.chunks(endingAfter: playingNow) {
            receiver.send(.audio(chunk))
        }
    }

    func setReceiverVolume(id: UUID, volume: Float) {
        queue.async {
            guard let r = self.receivers.first(where: { $0.id == id }) else { return }
            r.volume = volume
            r.send(.setVolume(volume))
            self.notify()
        }
    }

    func setReceiverDelay(id: UUID, delay: Double) {
        queue.async {
            guard let r = self.receivers.first(where: { $0.id == id }) else { return }
            r.delay = delay
            r.send(.setDelay(delay))
            self.notify()
        }
    }

    // MARK: Salida local

    func setLocalVolume(_ volume: Float) {
        queue.async {
            self.localVolume = volume
            self.localOutput.setVolume(self.playsLocally ? volume : 0)
            self.notify()
        }
    }

    func setLocalDelay(_ delay: Double) {
        queue.async {
            self.localDelay = delay
            self.localOutput.setUserDelay(delay)
            self.notify()
        }
    }

    /// Si se desactiva, el iPhone emisor solo coordina y no suena.
    func setPlaysLocally(_ enabled: Bool) {
        queue.async {
            self.playsLocally = enabled
            self.localOutput.setVolume(enabled ? self.localVolume : 0)
            self.notify()
        }
    }

    // MARK: Estado

    private func notify() {
        var s = Snapshot()
        s.sourceName = source?.displayName
        s.isPlaying = timeline != nil
        if let tl = timeline {
            let frame = max(Double(tl.anchorFrame), tl.frame(atHostTime: HostClock.now()))
            s.positionSeconds = frame / format.sampleRate
        } else {
            s.positionSeconds = format.seconds(forFrames: resumeFrame)
        }
        s.durationSeconds = source?.totalFrames.map { format.seconds(forFrames: $0) }
        s.receivers = receivers.map {
            ReceiverInfo(id: $0.id, name: $0.remoteName ?? $0.name, state: $0.state,
                         status: $0.lastStatus, volume: $0.volume, delay: $0.delay)
        }
        s.local = localOutput.snapshot
        s.localVolume = localVolume
        s.localDelay = localDelay
        s.playsLocally = playsLocally
        s.error = lastError
        onChange?(s)
    }
}
