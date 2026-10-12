import Foundation

/// Fuente de audio que el emisor puede leer en cualquier posición.
///
/// Leer por posición absoluta (en vez de "el siguiente bloque") simplifica
/// pausar y reanudar: el emisor simplemente pide desde el cuadro donde quedó.
public protocol AudioSource: AnyObject {
    var format: StreamFormat { get }
    /// Duración total en cuadros, o `nil` si la fuente es infinita.
    var totalFrames: Int64? { get }
    var displayName: String { get }
    /// Devuelve hasta `count` cuadros desde `frame` como Int16 entrelazado,
    /// o `nil` al llegar al final.
    func read(from frame: Int64, count: Int) throws -> [Int16]?
}

/// Pista de calibración: un "bip" corto cada medio segundo, con un tono más
/// agudo cada cuatro.
///
/// Sirve para ajustar el retraso de cada parlante a oído: cuando están bien
/// alineados se escucha un único clic nítido; si no, se oye un "doble clic"
/// o eco. Se genera matemáticamente a partir del número de cuadro, así que es
/// idéntica en cualquier posición y no requiere archivos.
public final class ClickTrackSource: AudioSource {
    public let format: StreamFormat
    public let totalFrames: Int64? = nil
    public let displayName = "Pista de calibración (clics)"

    public let beatInterval: Double
    public let beepDuration: Double
    public let amplitude: Double

    public init(format: StreamFormat = .standard,
                beatInterval: Double = 0.5,
                beepDuration: Double = 0.03,
                amplitude: Double = 0.6) {
        self.format = format
        self.beatInterval = beatInterval
        self.beepDuration = beepDuration
        self.amplitude = amplitude
    }

    public func read(from frame: Int64, count: Int) throws -> [Int16]? {
        guard count > 0, frame >= 0 else { return [] }
        let channels = format.channels
        var out = [Int16](repeating: 0, count: count * channels)
        for i in 0..<count {
            let value = sampleValue(atFrame: frame + Int64(i))
            for ch in 0..<channels {
                out[i * channels + ch] = value
            }
        }
        return out
    }

    /// Valor de la muestra en un cuadro absoluto.
    public func sampleValue(atFrame frame: Int64) -> Int16 {
        let t = Double(frame) / format.sampleRate
        let beat = (t / beatInterval).rounded(.down)
        let timeInBeat = t - beat * beatInterval
        guard timeInBeat < beepDuration else { return 0 }
        let frequency: Double = Int64(beat) % 4 == 0 ? 1_760 : 880
        // Rampa de 2 ms al inicio y al final para evitar chasquidos.
        let ramp = 0.002
        let envelope = min(1, timeInBeat / ramp, (beepDuration - timeInBeat) / ramp)
        let v = sin(2 * Double.pi * frequency * timeInBeat) * envelope * amplitude
        return Int16((v * Double(Int16.max)).rounded())
    }
}
