import Foundation

/// Relación lineal entre cuadros del flujo y el reloj del emisor.
///
/// El emisor publica un "ancla": el cuadro `anchorFrame` debe sonar en el
/// instante `anchorHostTime` (segundos del reloj monotónico del emisor). Desde
/// ahí cada cuadro posterior suena `1 / sampleRate` segundos después. Todos los
/// dispositivos usan la misma línea de tiempo; solo cambia cómo traducen el
/// reloj del emisor a su reloj local (ver `ClockSynchronizer`).
public struct PlaybackTimeline: Equatable, Sendable {
    public var streamID: UInt32
    public var anchorFrame: Int64
    public var anchorHostTime: Double
    public var sampleRate: Double

    public init(streamID: UInt32, anchorFrame: Int64, anchorHostTime: Double, sampleRate: Double) {
        self.streamID = streamID
        self.anchorFrame = anchorFrame
        self.anchorHostTime = anchorHostTime
        self.sampleRate = sampleRate
    }

    /// Instante (reloj del emisor) en que debe sonar `frame`.
    public func hostTime(forFrame frame: Int64) -> Double {
        anchorHostTime + Double(frame - anchorFrame) / sampleRate
    }

    /// Cuadro (fraccionario) que debe estar sonando en `hostTime`.
    public func frame(atHostTime hostTime: Double) -> Double {
        Double(anchorFrame) + (hostTime - anchorHostTime) * sampleRate
    }
}

/// Fórmulas de programación usadas por cada salida de audio.
///
/// Notación:
/// - `hostMinusLocal`: desfase de reloj (reloj del emisor − reloj local).
/// - `outputLatency`: tiempo desde que el motor de audio entrega una muestra
///   hasta que sale del parlante, según lo informa iOS (incluye Bluetooth).
/// - `userDelay`: ajuste manual (positivo = sonar más tarde) para compensar la
///   latencia interna de cada parlante que iOS no informa con exactitud.
public enum SyncMath {
    /// Instante local en que hay que *entregar* `frame` al hardware para que
    /// salga del parlante en el momento acordado.
    public static func localRenderTime(
        forFrame frame: Int64,
        timeline: PlaybackTimeline,
        hostMinusLocal: Double,
        outputLatency: Double,
        userDelay: Double
    ) -> Double {
        timeline.hostTime(forFrame: frame) - hostMinusLocal - outputLatency + userDelay
    }

    /// Cuadro que *debería* estar entregándose al hardware en `localRenderTime`.
    /// Es la inversa exacta de `localRenderTime(forFrame:)`.
    public static func expectedFrame(
        atLocalRenderTime localRenderTime: Double,
        timeline: PlaybackTimeline,
        hostMinusLocal: Double,
        outputLatency: Double,
        userDelay: Double
    ) -> Double {
        timeline.frame(atHostTime: localRenderTime + hostMinusLocal + outputLatency - userDelay)
    }
}
