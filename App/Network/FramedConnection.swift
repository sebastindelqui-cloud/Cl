import Foundation
import Network
import DualSoundCore

/// Parámetros de red comunes a emisor y receptores.
enum DualSoundNetwork {
    static func parameters() -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        // Sin algoritmo de Nagle: los pings de reloj no deben esperar a juntar bytes.
        tcp.noDelay = true
        // Detecta rápido un receptor que desapareció (se apagó o salió del WiFi).
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 2
        tcp.keepaliveInterval = 1
        tcp.keepaliveCount = 3
        tcp.connectionTimeout = 6
        let parameters = NWParameters(tls: nil, tcp: tcp)
        // Permite conectar dos iPhone cercanos aun sin router WiFi (AWDL).
        parameters.includePeerToPeer = true
        return parameters
    }

    /// Traduce errores de red a mensajes comprensibles.
    static func describe(_ error: NWError) -> String {
        if case .dns(let code) = error, code == -65570 /* kDNSServiceErr_PolicyDenied */ {
            return "Permiso de red local denegado. Actívalo en Ajustes › Privacidad y seguridad › Red local › DualSound."
        }
        if case .posix(let code) = error {
            switch code {
            case .ECONNREFUSED: return "El receptor rechazó la conexión (¿cerró la app?)."
            case .ETIMEDOUT: return "Tiempo de espera agotado: el otro dispositivo no responde."
            case .ENETDOWN, .ENETUNREACH: return "Sin red: conecta ambos dispositivos al mismo WiFi."
            default: break
            }
        }
        return error.localizedDescription
    }
}

/// Envuelve una `NWConnection` TCP y la convierte en un canal de `WireMessage`.
///
/// Todos los callbacks se ejecutan en la cola indicada al crearla.
final class FramedConnection {
    let connection: NWConnection
    private let queue: DispatchQueue
    private var framer = MessageFramer()

    /// Recibe cada mensaje junto con el instante local de llegada (útil para
    /// las mediciones de reloj).
    var onMessage: ((WireMessage, Double) -> Void)?
    var onStateChange: ((NWConnection.State) -> Void)?
    /// Se llama una sola vez cuando la conexión termina por cualquier motivo.
    var onClosed: ((String?) -> Void)?

    private var closed = false

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.onStateChange?(state)
            switch state {
            case .failed(let error):
                self.close(reason: DualSoundNetwork.describe(error))
            case .waiting(let error):
                // "Esperando" = no hay ruta ahora mismo. Se cierra y el dueño
                // decide si reintentar.
                self.close(reason: DualSoundNetwork.describe(error))
            case .cancelled:
                self.close(reason: nil)
            default:
                break
            }
        }
        receiveNext()
        connection.start(queue: queue)
    }

    func send(_ message: WireMessage) {
        guard !closed else { return }
        let data = Data(MessageFramer.frame(message))
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if let error { self?.close(reason: DualSoundNetwork.describe(error)) }
        })
    }

    func cancel() {
        close(reason: nil)
    }

    private func close(reason: String?) {
        guard !closed else { return }
        closed = true
        connection.cancel()
        onClosed?(reason)
    }

    private func receiveNext() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self, !self.closed else { return }
            let arrival = HostClock.now()
            if let data, !data.isEmpty {
                do {
                    for message in try self.framer.append(data) {
                        self.onMessage?(message, arrival)
                    }
                } catch {
                    self.close(reason: "Datos inválidos del otro dispositivo (\(error)).")
                    return
                }
            }
            if let error {
                self.close(reason: DualSoundNetwork.describe(error))
            } else if isComplete {
                self.close(reason: "El otro dispositivo cerró la conexión.")
            } else {
                self.receiveNext()
            }
        }
    }
}
