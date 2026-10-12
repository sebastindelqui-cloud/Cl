import AVFoundation
import Combine

/// Configura `AVAudioSession` y publica el estado real de la salida de audio.
///
/// Toda la información que muestra la app sobre "el parlante conectado" sale
/// de `AVAudioSession.currentRoute`: no se inventa ni se simula ningún
/// dispositivo. iOS solo expone *una* ruta de salida Bluetooth A2DP a la vez,
/// y aquí se refleja exactamente esa ruta.
@MainActor
final class AudioSessionManager: ObservableObject {
    static let shared = AudioSessionManager()

    enum Mode {
        /// Modo DualSound (emisor/receptor): baja latencia, cualquier salida.
        case synchronized
        /// Modo AirPlay 2: permite elegir varios parlantes AirPlay a la vez.
        case airPlay
    }

    struct Output: Identifiable, Hashable {
        let id: String
        let name: String
        let portType: AVAudioSession.Port

        var isBluetooth: Bool {
            [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE].contains(portType)
        }

        var kindDescription: String {
            switch portType {
            case .bluetoothA2DP: return "Bluetooth (A2DP)"
            case .bluetoothHFP: return "Bluetooth (perfil de llamadas)"
            case .bluetoothLE: return "Bluetooth LE"
            case .builtInSpeaker: return "Altavoz del dispositivo"
            case .builtInReceiver: return "Auricular del teléfono"
            case .headphones: return "Audífonos con cable"
            case .airPlay: return "AirPlay"
            case .HDMI: return "HDMI"
            case .usbAudio: return "Audio USB"
            case .carAudio: return "CarPlay"
            case .lineOut: return "Salida de línea"
            default: return portType.rawValue
            }
        }
    }

    @Published private(set) var outputs: [Output] = []
    @Published private(set) var outputLatency: TimeInterval = 0
    @Published private(set) var ioBufferDuration: TimeInterval = 0
    @Published private(set) var lastRouteEvent: String?
    @Published private(set) var configurationError: String?
    @Published private(set) var mode: Mode?

    /// Se incrementa en cada cambio de ruta, para que las vistas reaccionen.
    @Published private(set) var routeChangeCount = 0

    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
                                            object: session, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            let previousName = previous?.outputs.first?.portName
            Task { @MainActor in self?.handleRouteChange(reason: reason, previousName: previousName) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
                                            object: session, queue: .main) { [weak self] note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                .flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            Task { @MainActor in self?.handleInterruption(type) }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                            object: session, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, let mode = self.mode else { return }
                self.lastRouteEvent = "Se reiniciaron los servicios de audio de iOS."
                self.mode = nil
                self.configure(for: mode)
            }
        })
        refresh()
    }

    /// Activa la sesión de audio para el modo indicado.
    func configure(for newMode: Mode) {
        guard newMode != mode else { refresh(); return }
        let session = AVAudioSession.sharedInstance()
        do {
            switch newMode {
            case .synchronized:
                // Política por defecto: la salida que el usuario elija en el
                // Centro de control o con el botón de rutas (A2DP incluido).
                try session.setCategory(.playback, mode: .default, policy: .default, options: [])
                // Búfer de E/S corto: reduce la latencia y la granularidad de
                // la programación de audio. iOS puede ignorar la preferencia.
                try? session.setPreferredIOBufferDuration(0.005)
            case .airPlay:
                // "Audio de larga duración" es la política que habilita la
                // selección de varios parlantes AirPlay 2 desde una app.
                try session.setCategory(.playback, mode: .default, policy: .longFormAudio, options: [])
            }
            try session.setActive(true)
            mode = newMode
            configurationError = nil
        } catch {
            configurationError = "No se pudo activar el audio: \(error.localizedDescription)"
        }
        refresh()
    }

    func refresh() {
        let session = AVAudioSession.sharedInstance()
        outputs = session.currentRoute.outputs.map {
            Output(id: $0.uid, name: $0.portName, portType: $0.portType)
        }
        outputLatency = session.outputLatency
        ioBufferDuration = session.ioBufferDuration
    }

    /// Descripción de la salida actual, p. ej. "JBL Flip 5 · Bluetooth (A2DP)".
    var currentOutputDescription: String {
        guard !outputs.isEmpty else { return "Sin salida de audio" }
        return outputs.map { "\($0.name) · \($0.kindDescription)" }.joined(separator: ", ")
    }

    var hasBluetoothOutput: Bool { outputs.contains(where: \.isBluetooth) }

    /// Incompatibilidades detectadas a partir de la ruta real.
    var detectedIssues: [String] {
        var issues: [String] = []
        if outputs.isEmpty {
            issues.append("No hay ninguna salida de audio activa.")
        }
        if outputs.contains(where: { $0.portType == .builtInSpeaker }) {
            issues.append("El audio sale por el altavoz del dispositivo: ningún parlante Bluetooth está seleccionado como salida.")
        }
        if outputs.contains(where: { $0.portType == .bluetoothHFP }) {
            issues.append("El parlante está usando el perfil de llamadas (HFP): suena en calidad telefónica. Desconecta las llamadas o elige otra salida.")
        }
        if mode == .synchronized && outputs.contains(where: { $0.portType == .airPlay }) {
            issues.append("La salida es AirPlay: su retardo (~2 s) lo maneja iOS y no se puede compensar con precisión en el modo sincronizado. Usa el modo AirPlay 2.")
        }
        if outputLatency > 0.4 {
            issues.append(String(format: "Latencia de salida alta (%.0f ms). Funciona, pero la reacción a Reproducir/Pausa será lenta.", outputLatency * 1000))
        }
        if let configurationError { issues.append(configurationError) }
        return issues
    }

    private func handleRouteChange(reason: AVAudioSession.RouteChangeReason?, previousName: String?) {
        refresh()
        routeChangeCount += 1
        switch reason {
        case .oldDeviceUnavailable:
            lastRouteEvent = "Se desconectó \(previousName ?? "la salida anterior"). Ahora: \(currentOutputDescription)."
        case .newDeviceAvailable:
            lastRouteEvent = "Nueva salida: \(currentOutputDescription)."
        case .override, .categoryChange, .routeConfigurationChange:
            lastRouteEvent = "La salida cambió: \(currentOutputDescription)."
        default:
            break
        }
    }

    private func handleInterruption(_ type: AVAudioSession.InterruptionType?) {
        switch type {
        case .began:
            lastRouteEvent = "Audio interrumpido por el sistema (llamada, alarma u otra app)."
        case .ended:
            try? AVAudioSession.sharedInstance().setActive(true)
            lastRouteEvent = "Terminó la interrupción. Pulsa Reproducir si el audio no se reanudó."
        default:
            break
        }
        refresh()
    }
}
