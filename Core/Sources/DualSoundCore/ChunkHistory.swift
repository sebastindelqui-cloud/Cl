import Foundation

/// Memoria circular con el audio enviado recientemente.
///
/// Cuando un receptor se conecta o se reconecta a mitad de la reproducción, el
/// emisor le reenvía desde aquí los bloques que todavía no han sonado, así se
/// suma en menos de un segundo en lugar de esperar a que la canción empiece de
/// nuevo.
public struct ChunkHistory: Sendable {
    public let maxFrames: Int64
    private var chunks: [AudioChunk] = []

    public init(maxFrames: Int64) {
        precondition(maxFrames > 0)
        self.maxFrames = maxFrames
    }

    public var isEmpty: Bool { chunks.isEmpty }
    public var count: Int { chunks.count }

    /// Agrega un bloque. Si pertenece a otra sesión, descarta la anterior.
    public mutating func append(_ chunk: AudioChunk) {
        if let last = chunks.last, last.streamID != chunk.streamID {
            chunks.removeAll()
        }
        chunks.append(chunk)
        let oldestAllowed = chunk.endFrame - maxFrames
        if let firstKept = chunks.firstIndex(where: { $0.endFrame > oldestAllowed }), firstKept > 0 {
            chunks.removeFirst(firstKept)
        }
    }

    public mutating func removeAll() {
        chunks.removeAll()
    }

    /// Bloques que todavía contienen audio en o después de `frame`.
    public func chunks(endingAfter frame: Int64) -> [AudioChunk] {
        chunks.filter { $0.endFrame > frame }
    }
}
