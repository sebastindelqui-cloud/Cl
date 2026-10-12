import Foundation

/// Un bloque de audio PCM con su posición absoluta dentro del flujo.
///
/// `startFrame` es la clave de la sincronización: el emisor nunca dice "toca
/// esto ahora", sino "este bloque empieza en el cuadro N". Cada dispositivo
/// convierte N en un instante de su propio reloj con `PlaybackTimeline`.
public struct AudioChunk: Equatable, Sendable {
    /// Identifica la sesión de reproducción. Cambia en cada Reproducir/Reanudar,
    /// así los receptores descartan bloques de una sesión anterior.
    public var streamID: UInt32
    /// Posición del primer cuadro del bloque en el flujo.
    public var startFrame: Int64
    /// Muestras Int16 entrelazadas (L, R, L, R, …).
    public var samples: [Int16]
    public var channels: Int

    public init(streamID: UInt32, startFrame: Int64, samples: [Int16], channels: Int) {
        self.streamID = streamID
        self.startFrame = startFrame
        self.samples = samples
        self.channels = channels
    }

    public var frameCount: Int { channels > 0 ? samples.count / channels : 0 }
    public var endFrame: Int64 { startFrame + Int64(frameCount) }
}
