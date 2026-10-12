import XCTest
@testable import DualSoundCore

final class WireProtocolTests: XCTestCase {
    private let allMessages: [WireMessage] = [
        .hello(HostHello(hostName: "iPhone de Ana ñ", format: .standard)),
        .helloAck(ReceiverHello(receiverName: "Receptor 🔊")),
        .clockPing(id: 7, t0: 12_345.678_9),
        .clockPong(id: 7, t0: 1.5, t1: 2.25, t2: 2.250_1),
        .play(PlaybackTimeline(streamID: 3, anchorFrame: 96_000, anchorHostTime: 9_876.5, sampleRate: 48_000)),
        .audio(AudioChunk(streamID: 3, startFrame: -5, samples: [0, 1, -1, .max, .min, 1234], channels: 2)),
        .stop(streamID: 3),
        .setVolume(0.75),
        .setDelay(-0.042),
        .status(ReceiverStatus(isPlaying: true, clockSynchronized: true, clockRoundTrip: 0.004,
                               bufferedSeconds: 1.2, syncError: -0.001, outputLatency: 0.21,
                               outputName: "JBL Flip 5", droppedChunks: 2)),
        .status(ReceiverStatus(isPlaying: false, clockSynchronized: false, clockRoundTrip: 0,
                               bufferedSeconds: 0, syncError: .nan, outputLatency: 0,
                               outputName: "", droppedChunks: 0)),
    ]

    func testEveryMessageRoundTrips() throws {
        for message in allMessages {
            var framer = MessageFramer()
            let decoded = try framer.append(MessageFramer.frame(message))
            XCTAssertEqual(decoded, [message])
            XCTAssertEqual(framer.bufferedByteCount, 0)
        }
    }

    func testFramerHandlesByteByByteDeliveryAndBatches() throws {
        let stream = allMessages.flatMap { MessageFramer.frame($0) }
        var framer = MessageFramer()
        var received: [WireMessage] = []
        for byte in stream {
            received += try framer.append([byte])
        }
        XCTAssertEqual(received, allMessages)

        var batchFramer = MessageFramer()
        XCTAssertEqual(try batchFramer.append(stream), allMessages)
    }

    func testFramerKeepsPartialMessageUntilComplete() throws {
        let bytes = MessageFramer.frame(.stop(streamID: 99))
        var framer = MessageFramer()
        XCTAssertEqual(try framer.append(bytes.prefix(bytes.count - 1)), [])
        XCTAssertEqual(try framer.append(bytes.suffix(1)), [.stop(streamID: 99)])
    }

    func testHeaderIsBigEndianAndAudioLittleEndian() {
        let bytes = MessageFramer.frame(.audio(AudioChunk(streamID: 1, startFrame: 0, samples: [0x0102], channels: 1)))
        // longitud = 1 (tipo) + 4 + 8 + 1 + 4 + 2 = 20
        XCTAssertEqual(Array(bytes.prefix(5)), [0, 0, 0, 20, 6])
        XCTAssertEqual(Array(bytes.suffix(2)), [0x02, 0x01])
    }

    func testRejectsUnknownTypeTruncatedAndOversized() {
        var framer = MessageFramer()
        XCTAssertThrowsError(try framer.append([0, 0, 0, 1, 200])) {
            XCTAssertEqual($0 as? WireError, .unknownType(200))
        }
        var truncated = MessageFramer()
        // Mensaje "stop" que declara 3 bytes de cuerpo en vez de 4.
        XCTAssertThrowsError(try truncated.append([0, 0, 0, 4, 7, 0, 0, 0])) {
            XCTAssertEqual($0 as? WireError, .truncated)
        }
        var oversized = MessageFramer()
        XCTAssertThrowsError(try oversized.append([0x7F, 0, 0, 0, 6])) {
            XCTAssertEqual($0 as? WireError, .messageTooLarge(0x7F00_0000))
        }
        var empty = MessageFramer()
        XCTAssertThrowsError(try empty.append([0, 0, 0, 0])) {
            XCTAssertEqual($0 as? WireError, .emptyMessage)
        }
    }

    func testAudioChunkOfStandardSizeFitsInOneMessage() throws {
        let samples = (0..<(ProtocolConstants.chunkFrames * 2)).map { Int16(truncatingIfNeeded: $0 * 31) }
        let chunk = AudioChunk(streamID: 1, startFrame: 48_000, samples: samples, channels: 2)
        let bytes = MessageFramer.frame(.audio(chunk))
        XCTAssertLessThan(bytes.count, MessageFramer.maxMessageSize)
        var framer = MessageFramer()
        XCTAssertEqual(try framer.append(bytes), [.audio(chunk)])
        XCTAssertEqual(chunk.frameCount, ProtocolConstants.chunkFrames)
        XCTAssertEqual(chunk.endFrame, 48_000 + Int64(ProtocolConstants.chunkFrames))
    }
}
