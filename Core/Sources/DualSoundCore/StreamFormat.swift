import Foundation

/// Formato del flujo de audio que viaja por la red.
///
/// Todo el sistema trabaja con PCM lineal de 16 bits, entrelazado, a una
/// frecuencia fija. Usar un formato único evita que cada receptor tenga que
/// negociar conversiones y hace que "número de cuadro" signifique lo mismo en
/// todos los dispositivos, que es la base de la sincronización.
public struct StreamFormat: Equatable, Sendable {
    public var sampleRate: Double
    public var channels: Int

    public init(sampleRate: Double, channels: Int) {
        self.sampleRate = sampleRate
        self.channels = channels
    }

    /// 48 kHz estéreo: la frecuencia nativa de la mayoría de los parlantes A2DP
    /// y del hardware de iOS, así se evitan conversiones extra.
    public static let standard = StreamFormat(sampleRate: 48_000, channels: 2)

    public var bytesPerFrame: Int { channels * MemoryLayout<Int16>.size }

    public func seconds(forFrames frames: Int64) -> Double {
        Double(frames) / sampleRate
    }

    public func frames(forSeconds seconds: Double) -> Int64 {
        Int64((seconds * sampleRate).rounded())
    }
}

/// Constantes compartidas por el emisor y los receptores.
public enum ProtocolConstants {
    /// Versión del protocolo binario. Se incrementa ante cambios incompatibles.
    public static let version: UInt16 = 1

    /// Tipo de servicio Bonjour que anuncian los receptores. Debe coincidir con
    /// `NSBonjourServices` en Info.plist.
    public static let bonjourServiceType = "_dualsound._tcp"

    /// Cuadros por paquete de audio: 960 cuadros = 20 ms a 48 kHz.
    public static let chunkFrames = 960

    /// Tiempo entre "Reproducir" y el primer sonido. Debe cubrir la latencia
    /// de salida Bluetooth (~150–300 ms) más el envío inicial por WiFi.
    public static let startLeadTime: Double = 0.8

    /// Cuánto audio por delante del instante actual mantiene enviado el emisor.
    /// Es el colchón que absorbe la variación de latencia del WiFi.
    public static let sendAheadTime: Double = 1.5

    /// Audio reciente que guarda el emisor para que un receptor que se
    /// (re)conecta a mitad de canción pueda sumarse sin esperar.
    public static let historyDuration: Double = 3.0
}
