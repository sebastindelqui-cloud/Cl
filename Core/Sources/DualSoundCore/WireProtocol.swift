import Foundation

// MARK: - Mensajes

/// Saludo del emisor al conectarse a un receptor.
public struct HostHello: Equatable, Sendable {
    public var protocolVersion: UInt16
    public var hostName: String
    public var sampleRate: UInt32
    public var channels: UInt8

    public init(protocolVersion: UInt16 = ProtocolConstants.version, hostName: String, format: StreamFormat) {
        self.protocolVersion = protocolVersion
        self.hostName = hostName
        self.sampleRate = UInt32(format.sampleRate)
        self.channels = UInt8(format.channels)
    }

    public var format: StreamFormat { StreamFormat(sampleRate: Double(sampleRate), channels: Int(channels)) }
}

/// Respuesta del receptor al saludo.
public struct ReceiverHello: Equatable, Sendable {
    public var protocolVersion: UInt16
    public var receiverName: String

    public init(protocolVersion: UInt16 = ProtocolConstants.version, receiverName: String) {
        self.protocolVersion = protocolVersion
        self.receiverName = receiverName
    }
}

/// Estado que cada receptor informa periódicamente al emisor.
public struct ReceiverStatus: Equatable, Sendable {
    public var isPlaying: Bool
    public var clockSynchronized: Bool
    /// Mejor tiempo de ida y vuelta de la sincronización de reloj (s).
    public var clockRoundTrip: Float
    /// Audio recibido y programado que aún no ha sonado (s).
    public var bufferedSeconds: Float
    /// Error medido entre lo que suena y lo que debería sonar (s). NaN = sin medición.
    public var syncError: Float
    /// Latencia de salida informada por iOS para la ruta actual (s).
    public var outputLatency: Float
    /// Nombre de la salida de audio del receptor (su parlante Bluetooth).
    public var outputName: String
    /// Bloques descartados por llegar tarde desde que empezó la sesión.
    public var droppedChunks: UInt32

    public init(isPlaying: Bool, clockSynchronized: Bool, clockRoundTrip: Float,
                bufferedSeconds: Float, syncError: Float, outputLatency: Float,
                outputName: String, droppedChunks: UInt32) {
        self.isPlaying = isPlaying
        self.clockSynchronized = clockSynchronized
        self.clockRoundTrip = clockRoundTrip
        self.bufferedSeconds = bufferedSeconds
        self.syncError = syncError
        self.outputLatency = outputLatency
        self.outputName = outputName
        self.droppedChunks = droppedChunks
    }

    // NaN != NaN, así que la igualdad se define a mano.
    public static func == (a: ReceiverStatus, b: ReceiverStatus) -> Bool {
        a.isPlaying == b.isPlaying && a.clockSynchronized == b.clockSynchronized
            && a.clockRoundTrip == b.clockRoundTrip && a.bufferedSeconds == b.bufferedSeconds
            && (a.syncError == b.syncError || (a.syncError.isNaN && b.syncError.isNaN))
            && a.outputLatency == b.outputLatency && a.outputName == b.outputName
            && a.droppedChunks == b.droppedChunks
    }
}

/// Todos los mensajes del protocolo DualSound. Ver docs/PROTOCOLO.md.
public enum WireMessage: Equatable, Sendable {
    case hello(HostHello)                                            // emisor → receptor
    case helloAck(ReceiverHello)                                     // receptor → emisor
    case clockPing(id: UInt32, t0: Double)                           // receptor → emisor
    case clockPong(id: UInt32, t0: Double, t1: Double, t2: Double)   // emisor → receptor
    case play(PlaybackTimeline)                                      // emisor → receptor
    case audio(AudioChunk)                                           // emisor → receptor
    case stop(streamID: UInt32)                                      // emisor → receptor
    case setVolume(Float)                                            // emisor → receptor
    case setDelay(Double)                                            // emisor → receptor
    case status(ReceiverStatus)                                      // receptor → emisor

    public var typeCode: UInt8 {
        switch self {
        case .hello: return 1
        case .helloAck: return 2
        case .clockPing: return 3
        case .clockPong: return 4
        case .play: return 5
        case .audio: return 6
        case .stop: return 7
        case .setVolume: return 8
        case .setDelay: return 9
        case .status: return 10
        }
    }
}

public enum WireError: Error, Equatable {
    case truncated
    case unknownType(UInt8)
    case invalidString
    case invalidAudio
    case messageTooLarge(Int)
    case emptyMessage
}

// MARK: - Codificación

extension WireMessage {
    /// Cuerpo del mensaje (sin tipo ni longitud).
    public func encodePayload() -> [UInt8] {
        var w = ByteWriter()
        switch self {
        case .hello(let h):
            w.u16(h.protocolVersion); w.string(h.hostName); w.u32(h.sampleRate); w.u8(h.channels)
        case .helloAck(let r):
            w.u16(r.protocolVersion); w.string(r.receiverName)
        case let .clockPing(id, t0):
            w.u32(id); w.f64(t0)
        case let .clockPong(id, t0, t1, t2):
            w.u32(id); w.f64(t0); w.f64(t1); w.f64(t2)
        case .play(let t):
            w.u32(t.streamID); w.i64(t.anchorFrame); w.f64(t.anchorHostTime); w.f64(t.sampleRate)
        case .audio(let c):
            w.u32(c.streamID); w.i64(c.startFrame); w.u8(UInt8(c.channels))
            w.u32(UInt32(c.frameCount)); w.int16LE(c.samples)
        case .stop(let id):
            w.u32(id)
        case .setVolume(let v):
            w.f32(v)
        case .setDelay(let d):
            w.f64(d)
        case .status(let s):
            w.u8(s.isPlaying ? 1 : 0); w.u8(s.clockSynchronized ? 1 : 0)
            w.f32(s.clockRoundTrip); w.f32(s.bufferedSeconds); w.f32(s.syncError)
            w.f32(s.outputLatency); w.string(s.outputName); w.u32(s.droppedChunks)
        }
        return w.bytes
    }

    public static func decode(type: UInt8, payload: ArraySlice<UInt8>) throws -> WireMessage {
        var r = ByteReader(payload)
        let message: WireMessage
        switch type {
        case 1:
            let version = try r.u16(); let name = try r.string()
            let rate = try r.u32(); let ch = try r.u8()
            var h = HostHello(hostName: name, format: StreamFormat(sampleRate: Double(rate), channels: Int(ch)))
            h.protocolVersion = version
            message = .hello(h)
        case 2:
            let version = try r.u16()
            message = .helloAck(ReceiverHello(protocolVersion: version, receiverName: try r.string()))
        case 3:
            message = .clockPing(id: try r.u32(), t0: try r.f64())
        case 4:
            message = .clockPong(id: try r.u32(), t0: try r.f64(), t1: try r.f64(), t2: try r.f64())
        case 5:
            message = .play(PlaybackTimeline(streamID: try r.u32(), anchorFrame: try r.i64(),
                                             anchorHostTime: try r.f64(), sampleRate: try r.f64()))
        case 6:
            let id = try r.u32(); let start = try r.i64(); let ch = Int(try r.u8())
            let frames = Int(try r.u32())
            guard ch > 0 else { throw WireError.invalidAudio }
            let samples = try r.int16LE(count: frames * ch)
            message = .audio(AudioChunk(streamID: id, startFrame: start, samples: samples, channels: ch))
        case 7:
            message = .stop(streamID: try r.u32())
        case 8:
            message = .setVolume(try r.f32())
        case 9:
            message = .setDelay(try r.f64())
        case 10:
            let playing = try r.u8() != 0; let synced = try r.u8() != 0
            let rtt = try r.f32(); let buffered = try r.f32(); let err = try r.f32()
            let latency = try r.f32(); let name = try r.string(); let dropped = try r.u32()
            message = .status(ReceiverStatus(isPlaying: playing, clockSynchronized: synced, clockRoundTrip: rtt,
                                             bufferedSeconds: buffered, syncError: err, outputLatency: latency,
                                             outputName: name, droppedChunks: dropped))
        default:
            throw WireError.unknownType(type)
        }
        return message
    }
}

// MARK: - Entramado sobre TCP

/// Separa el flujo TCP en mensajes.
///
/// Formato de cada mensaje: `longitud (UInt32 big-endian)` + `tipo (UInt8)` +
/// `cuerpo`. La longitud cuenta el byte de tipo más el cuerpo.
public struct MessageFramer: Sendable {
    /// Límite de seguridad: ningún mensaje legítimo se acerca a 1 MiB.
    public static let maxMessageSize = 1 << 20

    private var buffer: [UInt8] = []
    private var head = 0

    public init() {}

    public static func frame(_ message: WireMessage) -> [UInt8] {
        let payload = message.encodePayload()
        var w = ByteWriter()
        w.u32(UInt32(payload.count + 1))
        w.u8(message.typeCode)
        w.bytes.append(contentsOf: payload)
        return w.bytes
    }

    /// Agrega bytes recibidos y devuelve los mensajes completos disponibles.
    /// Un error indica datos corruptos: hay que cerrar la conexión.
    public mutating func append<S: Sequence>(_ data: S) throws -> [WireMessage] where S.Element == UInt8 {
        buffer.append(contentsOf: data)
        var messages: [WireMessage] = []
        while buffer.count - head >= 4 {
            let length = Int(buffer[head]) << 24 | Int(buffer[head + 1]) << 16
                | Int(buffer[head + 2]) << 8 | Int(buffer[head + 3])
            guard length >= 1 else { throw WireError.emptyMessage }
            guard length <= Self.maxMessageSize else { throw WireError.messageTooLarge(length) }
            guard buffer.count - head >= 4 + length else { break }
            let type = buffer[head + 4]
            let payload = buffer[(head + 5)..<(head + 4 + length)]
            messages.append(try WireMessage.decode(type: type, payload: payload))
            head += 4 + length
        }
        // Compacta de vez en cuando para no crecer sin límite.
        if head > 0 && (head == buffer.count || head > 64 * 1024) {
            buffer.removeFirst(head)
            head = 0
        }
        return messages
    }

    public var bufferedByteCount: Int { buffer.count - head }
}

// MARK: - Utilidades binarias (big-endian salvo el audio)

struct ByteWriter {
    var bytes: [UInt8] = []

    mutating func u8(_ v: UInt8) { bytes.append(v) }
    mutating func u16(_ v: UInt16) { withUnsafeBytes(of: v.bigEndian) { bytes.append(contentsOf: $0) } }
    mutating func u32(_ v: UInt32) { withUnsafeBytes(of: v.bigEndian) { bytes.append(contentsOf: $0) } }
    mutating func u64(_ v: UInt64) { withUnsafeBytes(of: v.bigEndian) { bytes.append(contentsOf: $0) } }
    mutating func i64(_ v: Int64) { u64(UInt64(bitPattern: v)) }
    mutating func f32(_ v: Float) { u32(v.bitPattern) }
    mutating func f64(_ v: Double) { u64(v.bitPattern) }

    mutating func string(_ s: String) {
        var utf8 = Array(s.utf8)
        if utf8.count > Int(UInt16.max) { utf8 = Array(utf8.prefix(Int(UInt16.max))) }
        u16(UInt16(utf8.count))
        bytes.append(contentsOf: utf8)
    }

    /// El audio va en little-endian, el orden nativo de todos los
    /// dispositivos Apple, para copiarlo sin convertir muestra por muestra.
    mutating func int16LE(_ samples: [Int16]) {
        #if _endian(little)
        samples.withUnsafeBytes { bytes.append(contentsOf: $0) }
        #else
        for s in samples { withUnsafeBytes(of: s.littleEndian) { bytes.append(contentsOf: $0) } }
        #endif
    }
}

struct ByteReader {
    private let data: ArraySlice<UInt8>
    private var index: Int

    init(_ data: ArraySlice<UInt8>) {
        self.data = data
        self.index = data.startIndex
    }

    private mutating func take(_ n: Int) throws -> ArraySlice<UInt8> {
        guard n >= 0, data.endIndex - index >= n else { throw WireError.truncated }
        defer { index += n }
        return data[index..<(index + n)]
    }

    private mutating func uint<T: FixedWidthInteger>(_: T.Type) throws -> T {
        try take(MemoryLayout<T>.size).reduce(T(0)) { $0 << 8 | T($1) }
    }

    mutating func u8() throws -> UInt8 { try uint(UInt8.self) }
    mutating func u16() throws -> UInt16 { try uint(UInt16.self) }
    mutating func u32() throws -> UInt32 { try uint(UInt32.self) }
    mutating func u64() throws -> UInt64 { try uint(UInt64.self) }
    mutating func i64() throws -> Int64 { Int64(bitPattern: try u64()) }
    mutating func f32() throws -> Float { Float(bitPattern: try u32()) }
    mutating func f64() throws -> Double { Double(bitPattern: try u64()) }

    mutating func string() throws -> String {
        let length = Int(try u16())
        guard let s = String(bytes: try take(length), encoding: .utf8) else { throw WireError.invalidString }
        return s
    }

    mutating func int16LE(count: Int) throws -> [Int16] {
        guard count >= 0 else { throw WireError.invalidAudio }
        let raw = try take(count * 2)
        var samples = [Int16](repeating: 0, count: count)
        samples.withUnsafeMutableBytes { dst in
            raw.withUnsafeBytes { src in dst.copyMemory(from: src) }
        }
        #if _endian(big)
        for i in samples.indices { samples[i] = Int16(littleEndian: samples[i]) }
        #endif
        return samples
    }
}
