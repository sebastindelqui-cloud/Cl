import XCTest
@testable import DualSoundCore

final class ClockSynchronizerTests: XCTestCase {
    /// Simula un receptor cuyo reloj va `trueOffset` segundos detrás del
    /// emisor, con demoras de red asimétricas y variables.
    private func sample(at local: Double, trueOffset: Double, up: Double, down: Double,
                        processing: Double = 0.0002) -> ClockSample {
        let t0 = local
        let t1 = t0 + trueOffset + up
        let t2 = t1 + processing
        let t3 = t2 - trueOffset + down
        return ClockSample(t0: t0, t1: t1, t2: t2, t3: t3)
    }

    func testSymmetricSampleGivesExactOffset() {
        let s = sample(at: 100, trueOffset: 42.5, up: 0.003, down: 0.003)
        XCTAssertEqual(s.offset, 42.5, accuracy: 1e-9)
        XCTAssertEqual(s.roundTrip, 0.006, accuracy: 1e-9)
    }

    func testMinimumRoundTripFilterRejectsJitter() {
        var sync = ClockSynchronizer()
        XCTAssertNil(sync.offset)
        let trueOffset = -1234.567
        // Mediciones muy asimétricas (WiFi congestionado) y una limpia.
        let delays: [(Double, Double)] = [(0.040, 0.002), (0.002, 0.030), (0.0015, 0.0016),
                                          (0.020, 0.090), (0.060, 0.004), (0.010, 0.011)]
        for (i, d) in delays.enumerated() {
            sync.add(sample(at: Double(i), trueOffset: trueOffset, up: d.0, down: d.1))
        }
        XCTAssertTrue(sync.isSynchronized)
        // El error queda acotado por la asimetría de la mejor medición (0,05 ms).
        XCTAssertEqual(sync.offset!, trueOffset, accuracy: 0.0001)
        XCTAssertEqual(sync.bestRoundTrip!, 0.0031, accuracy: 0.0003)
        XCTAssertEqual(sync.localTime(fromHost: 10)!, 10 - trueOffset, accuracy: 0.0001)
        XCTAssertEqual(sync.hostTime(fromLocal: 10)!, 10 + trueOffset, accuracy: 0.0001)
    }

    func testRejectsInvalidSamplesAndKeepsWindow() {
        var sync = ClockSynchronizer(windowSize: 3, maxAcceptedRoundTrip: 0.1, minimumSamples: 2)
        XCTAssertFalse(sync.add(sample(at: 0, trueOffset: 1, up: 0.2, down: 0.2)))   // RTT 0,4 s
        XCTAssertFalse(sync.add(ClockSample(t0: 10, t1: 0, t2: 0, t3: 9)))            // RTT negativo
        XCTAssertEqual(sync.sampleCount, 0)
        for i in 0..<5 { sync.add(sample(at: Double(i), trueOffset: 1, up: 0.01, down: 0.01)) }
        XCTAssertEqual(sync.sampleCount, 3)
        sync.reset()
        XCTAssertFalse(sync.isSynchronized)
    }

    func testTracksSlowClockDriftThroughWindow() {
        // 50 ppm de deriva: el desfase cambia 50 µs por segundo.
        var sync = ClockSynchronizer(windowSize: 10)
        for second in 0..<120 {
            let offset = 5 + Double(second) * 50e-6
            sync.add(sample(at: Double(second), trueOffset: offset, up: 0.002, down: 0.002))
        }
        XCTAssertEqual(sync.offset!, 5 + 119 * 50e-6, accuracy: 0.0006)
    }
}

final class TimelineTests: XCTestCase {
    func testFrameAndTimeAreInverse() {
        let t = PlaybackTimeline(streamID: 1, anchorFrame: 48_000, anchorHostTime: 500, sampleRate: 48_000)
        XCTAssertEqual(t.hostTime(forFrame: 48_000), 500)
        XCTAssertEqual(t.hostTime(forFrame: 96_000), 501)
        XCTAssertEqual(t.hostTime(forFrame: 0), 499)
        XCTAssertEqual(t.frame(atHostTime: 500.5), 72_000)
    }

    func testTwoDevicesWithDifferentClocksAndLatenciesEmitSameFrameTogether() {
        let timeline = PlaybackTimeline(streamID: 1, anchorFrame: 0, anchorHostTime: 1_000, sampleRate: 48_000)
        // Dispositivo A: es el emisor (desfase 0), parlante con 180 ms de latencia.
        // Dispositivo B: reloj 7 s detrás, parlante con 250 ms y ajuste manual de +15 ms.
        let a = (offset: 0.0, latency: 0.180, delay: 0.0)
        let b = (offset: 7.0, latency: 0.250, delay: 0.015)
        let frame: Int64 = 24_000
        let renderA = SyncMath.localRenderTime(forFrame: frame, timeline: timeline,
                                               hostMinusLocal: a.offset, outputLatency: a.latency, userDelay: a.delay)
        let renderB = SyncMath.localRenderTime(forFrame: frame, timeline: timeline,
                                               hostMinusLocal: b.offset, outputLatency: b.latency, userDelay: b.delay)
        // Instante (reloj del emisor) en que el sonido sale de cada parlante.
        let soundA = renderA + a.offset + a.latency
        let soundB = renderB + b.offset + b.latency - b.delay
        XCTAssertEqual(soundA, 1_000.5, accuracy: 1e-9)
        XCTAssertEqual(soundB, soundA, accuracy: 1e-9)

        // La fórmula de error es la inversa exacta.
        let expected = SyncMath.expectedFrame(atLocalRenderTime: renderB, timeline: timeline,
                                              hostMinusLocal: b.offset, outputLatency: b.latency, userDelay: b.delay)
        XCTAssertEqual(expected, Double(frame), accuracy: 1e-6)
    }
}

final class DriftControllerTests: XCTestCase {
    func testDeadbandKeepsNormalSpeed() {
        var d = DriftController()
        XCTAssertEqual(d.update(measuredError: 0.001), .adjustRate(1))
        XCTAssertEqual(d.update(measuredError: -0.001), .adjustRate(1))
    }

    func testAheadSlowsDownAndBehindSpeedsUpWithinLimits() {
        var ahead = DriftController()
        guard case .adjustRate(let slow) = ahead.update(measuredError: 0.004) else { return XCTFail() }
        XCTAssertLessThan(slow, 1)
        XCTAssertGreaterThanOrEqual(slow, 0.998)

        var behind = DriftController()
        guard case .adjustRate(let fast) = behind.update(measuredError: -0.030) else { return XCTFail() }
        XCTAssertEqual(fast, 1.002, accuracy: 1e-12)
    }

    func testLargeErrorRequestsHardResync() {
        var d = DriftController()
        _ = d.update(measuredError: 0.01)
        XCTAssertEqual(d.update(measuredError: 0.2), .hardResync)
        XCTAssertNil(d.smoothedError)
        XCTAssertEqual(d.rate, 1)
    }

    /// Simulación de lazo cerrado: un reloj de audio 80 ppm más rápido debe
    /// mantenerse dentro de ±3 ms durante 10 minutos.
    func testClosedLoopCompensatesHardwareClockDrift() {
        var controller = DriftController()
        let hardwareSkew = 80e-6
        let tick = 0.25
        var error = 0.0
        var rate = 1.0
        var worst = 0.0
        for step in 0..<(10 * 60 * 4) {
            error += tick * ((1 + hardwareSkew) * rate - 1)
            switch controller.update(measuredError: error) {
            case .adjustRate(let r): rate = r
            case .hardResync: return XCTFail("no debería requerir resincronización")
            }
            if step > 40 { worst = max(worst, abs(error)) }
        }
        XCTAssertLessThan(worst, 0.003)
    }
}

final class ChunkHistoryTests: XCTestCase {
    private func chunk(_ stream: UInt32, _ start: Int64, frames: Int = 10) -> AudioChunk {
        AudioChunk(streamID: stream, startFrame: start, samples: Array(repeating: 1, count: frames * 2), channels: 2)
    }

    func testEvictsOldAudioAndReturnsPendingChunks() {
        var h = ChunkHistory(maxFrames: 30)
        for i in 0..<10 { h.append(chunk(1, Int64(i * 10))) }
        XCTAssertEqual(h.count, 3)
        XCTAssertEqual(h.chunks(endingAfter: 0).map(\.startFrame), [70, 80, 90])
        XCTAssertEqual(h.chunks(endingAfter: 85).map(\.startFrame), [80, 90])
        XCTAssertEqual(h.chunks(endingAfter: 100), [])
    }

    func testNewStreamClearsPreviousOne() {
        var h = ChunkHistory(maxFrames: 1_000)
        h.append(chunk(1, 0)); h.append(chunk(1, 10))
        h.append(chunk(2, 500))
        XCTAssertEqual(h.chunks(endingAfter: 0).map(\.streamID), [2])
    }
}

final class ClickTrackTests: XCTestCase {
    func testBeepsAtBeatsAndSilenceBetween() throws {
        let src = ClickTrackSource()
        XCTAssertNil(src.totalFrames)
        let rate = Int64(src.format.sampleRate)
        // Cerca del inicio de cada pulso hay sonido; a mitad de pulso, silencio.
        XCTAssertNotEqual(src.sampleValue(atFrame: rate / 200), 0)          // 5 ms
        XCTAssertEqual(src.sampleValue(atFrame: rate / 4), 0)               // 250 ms
        XCTAssertNotEqual(src.sampleValue(atFrame: rate / 2 + rate / 200), 0)
        // Es determinista: leer en cualquier posición da lo mismo.
        let a = try XCTUnwrap(src.read(from: 23_990, count: 100))
        let b = try XCTUnwrap(src.read(from: 24_000, count: 90))
        XCTAssertEqual(Array(a[20...]), b)
        XCTAssertEqual(a.count, 200)
        // Ambos canales son iguales.
        XCTAssertEqual(a[40], a[41])
    }
}
