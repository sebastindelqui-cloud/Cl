import Foundation
import Network
import DualSoundCore

/// Receptor encontrado por Bonjour en la red local.
struct DiscoveredReceiver: Identifiable, Hashable {
    let name: String
    let endpoint: NWEndpoint
    var id: String { name }
}

/// Busca receptores DualSound en la red local (Bonjour).
final class ReceiverBrowser {
    var onChange: (([DiscoveredReceiver]) -> Void)?
    var onError: ((String?) -> Void)?

    private let queue: DispatchQueue
    private var browser: NWBrowser?

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjour(type: ProtocolConstants.bonjourServiceType, domain: nil),
                                using: DualSoundNetwork.parameters())
        browser.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed(let error), .waiting(let error):
                self?.onError?(DualSoundNetwork.describe(error))
            case .ready:
                self?.onError?(nil)
            default:
                break
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found: [DiscoveredReceiver] = results.compactMap { result in
                guard case let .service(name, _, _, _) = result.endpoint else { return nil }
                return DiscoveredReceiver(name: name, endpoint: result.endpoint)
            }
            self?.onChange?(found.sorted { $0.name < $1.name })
        }
        browser.start(queue: queue)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }
}

/// Conexión del emisor con un receptor concreto.
///
/// Se encarga del saludo, de responder los pings de reloj, de recibir el
/// estado del receptor y de reconectarse automáticamente si se corta la
/// conexión (con espera exponencial de 1 a 8 s). Vive en la cola del emisor.
final class RemoteReceiver {
    enum State: Equatable {
        case connecting
        case connected
        case reconnecting(attempt: Int, reason: String?)
        case incompatible(String)
    }

    let id = UUID()
    let name: String
    let endpoint: NWEndpoint
    private let queue: DispatchQueue
    private let hostHello: HostHello

    private(set) var state: State = .connecting
    private(set) var lastStatus: ReceiverStatus?
    private(set) var remoteName: String?
    var volume: Float = 1
    var delay: Double = 0

    /// El receptor completó el saludo y está listo para recibir audio.
    var onReady: ((RemoteReceiver) -> Void)?
    /// Cambió el estado o llegó un informe nuevo.
    var onUpdate: (() -> Void)?

    private var connection: FramedConnection?
    private var generation = 0
    private var attempt = 0
    private var removed = false

    init(name: String, endpoint: NWEndpoint, hostHello: HostHello, queue: DispatchQueue) {
        self.name = name
        self.endpoint = endpoint
        self.hostHello = hostHello
        self.queue = queue
    }

    var isConnected: Bool { state == .connected }

    func start() {
        connect()
    }

    /// Envía un mensaje solo si el receptor ya completó el saludo.
    func send(_ message: WireMessage) {
        guard state == .connected else { return }
        connection?.send(message)
    }

    func remove() {
        removed = true
        generation += 1
        connection?.cancel()
        connection = nil
    }

    private func connect() {
        generation += 1
        let myGeneration = generation
        let framed = FramedConnection(connection: NWConnection(to: endpoint, using: DualSoundNetwork.parameters()),
                                      queue: queue)
        framed.onStateChange = { [weak self, weak framed] state in
            guard let self, myGeneration == self.generation, case .ready = state else { return }
            framed?.send(.hello(self.hostHello))
        }
        framed.onMessage = { [weak self] message, arrival in
            guard let self, myGeneration == self.generation else { return }
            self.handle(message, arrival: arrival)
        }
        framed.onClosed = { [weak self] reason in
            guard let self, myGeneration == self.generation else { return }
            self.scheduleReconnect(reason: reason)
        }
        connection = framed
        state = attempt == 0 ? .connecting : state
        framed.start()
        onUpdate?()
    }

    private func handle(_ message: WireMessage, arrival: Double) {
        switch message {
        case .helloAck(let ack):
            guard ack.protocolVersion == ProtocolConstants.version else {
                state = .incompatible("El receptor usa otra versión de DualSound (protocolo \(ack.protocolVersion)). Actualiza ambas apps.")
                generation += 1
                connection?.cancel()
                onUpdate?()
                return
            }
            remoteName = ack.receiverName
            state = .connected
            attempt = 0
            send(.setVolume(volume))
            send(.setDelay(delay))
            onReady?(self)
            onUpdate?()
        case let .clockPing(id, t0):
            // t1 = llegada del ping, t2 = salida de la respuesta.
            connection?.send(.clockPong(id: id, t0: t0, t1: arrival, t2: HostClock.now()))
        case .status(let status):
            lastStatus = status
            onUpdate?()
        default:
            break // Mensajes que solo envía el emisor: se ignoran.
        }
    }

    private func scheduleReconnect(reason: String?) {
        connection = nil
        lastStatus = nil
        guard !removed else { return }
        if case .incompatible = state { return }
        attempt += 1
        state = .reconnecting(attempt: attempt, reason: reason)
        onUpdate?()
        let delay = min(8, pow(2, Double(attempt - 1)))
        let expected = generation
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.removed, self.generation == expected else { return }
            self.connect()
        }
    }
}
