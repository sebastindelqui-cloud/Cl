import AVFoundation
import DualSoundCore

/// Reproduce un flujo de `AudioChunk` de modo que cada cuadro salga del
/// parlante en el instante que marca la `PlaybackTimeline` compartida.
///
/// La usan tanto el emisor (para su propio parlante, con desfase de reloj 0)
/// como cada receptor (con el desfase medido por `ClockSynchronizer`).
///
/// Cómo funciona:
/// 1. El primer bloque se programa con `AVAudioPlayerNode.play(at:)` en el
///    instante local exacto, descontando la latencia de salida que informa
///    iOS para la ruta actual (que en Bluetooth incluye el retardo A2DP).
/// 2. Los bloques siguientes se programan en posiciones de muestra
///    explícitas, así un bloque perdido deja un silencio pero no corre el
///    resto del audio.
/// 3. Cada 250 ms se compara el cuadro que realmente se está entregando con
///    el que debería, y `DriftController` corrige con `AVAudioUnitVarispeed`
///    (cambios de velocidad ≤ 0,2 %) o reprograma si el error es grande.
///
/// Todo el estado vive en una cola serie privada; los métodos públicos se
/// pueden llamar desde cualquier hilo.
final class SyncedAudioOutput {
    struct Snapshot {
        var isPlaying = false
        var bufferedSeconds: Double = 0
        /// Segundos que el audio va adelantado (+) o atrasado (−). `nil` sin medición.
        var syncError: Double?
        var rate: Double = 1
        var outputLatency: Double = 0
        var droppedChunks = 0
        var lastError: String?
    }

    let format: StreamFormat
    private let avFormat: AVAudioFormat
    private let queue = DispatchQueue(label: "dualsound.output", qos: .userInteractive)
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let varispeed = AVAudioUnitVarispeed()

    private var timeline: PlaybackTimeline?
    private var hostMinusLocal: Double?
    private var userDelay: Double = 0
    /// Bloques que aún no terminaron de sonar; permiten reprogramar sin pedir
    /// nada al emisor.
    private var retained: [AudioChunk] = []
    /// Cuadro del flujo que corresponde a la muestra 0 del reproductor.
    private var playerStartFrame: Int64?
    private var lastScheduledEndFrame: Int64?
    private var appliedLatency: Double = 0
    private var drift = DriftController()
    private var droppedChunks = 0
    private var lastError: String?
    private var lastSyncError: Double?
    private var timer: DispatchSourceTimer?
    private var configObserver: NSObjectProtocol?

    private let snapshotLock = NSLock()
    private var _snapshot = Snapshot()

    /// Estado más reciente, seguro de leer desde cualquier hilo.
    var snapshot: Snapshot {
        snapshotLock.lock(); defer { snapshotLock.unlock() }
        return _snapshot
    }

    init(format: StreamFormat = .standard) {
        self.format = format
        // Float32 no entrelazado: el formato nativo de AVAudioEngine.
        avFormat = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate,
                                 channels: AVAudioChannelCount(format.channels))!
        engine.attach(player)
        engine.attach(varispeed)
        engine.connect(player, to: varispeed, format: avFormat)
        engine.connect(varispeed, to: engine.mainMixerNode, format: avFormat)

        // Si cambia el hardware (p. ej., se desconecta el parlante), el motor
        // se detiene solo. Se reinicia y se reprograma con la nueva latencia.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.queue.async { self?.handleConfigurationChange() }
        }

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    deinit {
        timer?.cancel()
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        engine.stop()
    }

    // MARK: API pública

    /// Desfase de reloj (emisor − local). `nil` mientras no esté sincronizado.
    func setClockOffset(_ offset: Double?) {
        queue.async {
            let wasUnknown = self.hostMinusLocal == nil
            self.hostMinusLocal = offset
            if wasUnknown, offset != nil { self.resync() }
        }
    }

    /// Ajuste manual de retardo (segundos, positivo = sonar más tarde).
    func setUserDelay(_ delay: Double) {
        queue.async {
            guard abs(delay - self.userDelay) > 0.0005 else { return }
            self.userDelay = delay
            if self.playerStartFrame != nil { self.resync() }
        }
    }

    func setVolume(_ volume: Float) {
        queue.async { self.engine.mainMixerNode.outputVolume = max(0, min(1, volume)) }
    }

    /// Comienza una nueva sesión de reproducción. Los bloques llegan después
    /// con `enqueue`.
    func start(timeline: PlaybackTimeline) {
        queue.async {
            self.resetPlayback()
            self.timeline = timeline
            self.droppedChunks = 0
            self.ensureEngineRunning()
            self.publishSnapshot()
        }
    }

    func enqueue(_ chunk: AudioChunk) {
        queue.async {
            guard let timeline = self.timeline, chunk.streamID == timeline.streamID,
                  chunk.channels == self.format.channels else { return }
            self.retained.append(chunk)
            self.schedule(chunk)
        }
    }

    func stop() {
        queue.async {
            self.resetPlayback()
            self.timeline = nil
            self.publishSnapshot()
        }
    }

    // MARK: Programación

    private func ensureEngineRunning() {
        guard !engine.isRunning else { return }
        do {
            engine.prepare()
            try engine.start()
            lastError = nil
        } catch {
            lastError = "No se pudo iniciar el audio: \(error.localizedDescription)"
        }
    }

    private func resetPlayback() {
        player.stop()
        retained.removeAll()
        playerStartFrame = nil
        lastScheduledEndFrame = nil
        lastSyncError = nil
        drift.reset()
        varispeed.rate = 1
    }

    /// Latencia total desde que el motor entrega una muestra hasta que suena.
    private func currentOutputLatency() -> Double {
        let session = AVAudioSession.sharedInstance()
        return session.outputLatency + session.ioBufferDuration
    }

    /// Detiene el reproductor y vuelve a programar todo lo retenido según la
    /// línea de tiempo, el desfase y la latencia actuales.
    private func resync() {
        player.stop()
        playerStartFrame = nil
        lastScheduledEndFrame = nil
        drift.reset()
        varispeed.rate = 1
        ensureEngineRunning()
        for chunk in retained { schedule(chunk) }
    }

    private func schedule(_ chunk: AudioChunk) {
        guard let timeline, let offset = hostMinusLocal, engine.isRunning else { return }

        guard let startFrame = playerStartFrame else {
            // Primer bloque: fija el instante de arranque del reproductor.
            let latency = currentOutputLatency()
            let renderTime = SyncMath.localRenderTime(forFrame: chunk.startFrame, timeline: timeline,
                                                      hostMinusLocal: offset, outputLatency: latency,
                                                      userDelay: userDelay)
            // Necesita un margen mínimo para que Core Audio lo pueda cumplir.
            guard renderTime > HostClock.now() + 0.03 else {
                droppedChunks += 1
                return
            }
            appliedLatency = latency
            playerStartFrame = chunk.startFrame
            lastScheduledEndFrame = chunk.endFrame
            player.scheduleBuffer(makeBuffer(chunk), at: AVAudioTime(sampleTime: 0, atRate: format.sampleRate),
                             options: [], completionHandler: nil)
            player.play(at: AVAudioTime(hostTime: HostClock.hostTicks(forSeconds: renderTime)))
            return
        }

        // Duplicado o solapado (p. ej., reenvío tras reconexión).
        if let end = lastScheduledEndFrame, chunk.startFrame < end { return }
        // Llegó tarde: programarlo en el pasado lo haría sonar desfasado.
        if let current = currentPlayerFrame(),
           chunk.startFrame < current + format.frames(forSeconds: 0.01) {
            droppedChunks += 1
            return
        }
        let sampleTime = AVAudioFramePosition(chunk.startFrame - startFrame)
        player.scheduleBuffer(makeBuffer(chunk), at: AVAudioTime(sampleTime: sampleTime, atRate: format.sampleRate),
                             options: [], completionHandler: nil)
        lastScheduledEndFrame = chunk.endFrame
    }

    private func makeBuffer(_ chunk: AudioChunk) -> AVAudioPCMBuffer {
        let frames = chunk.frameCount
        let buffer = AVAudioPCMBuffer(pcmFormat: avFormat, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        let channels = chunk.channels
        let scale: Float = 1.0 / 32_768.0
        chunk.samples.withUnsafeBufferPointer { src in
            for ch in 0..<channels {
                let dst = buffer.floatChannelData![ch]
                for i in 0..<frames {
                    dst[i] = Float(src[i * channels + ch]) * scale
                }
            }
        }
        return buffer
    }

    /// Cuadro del flujo que el reproductor está entregando ahora, con el
    /// instante local de ese ciclo de render.
    private func currentRender() -> (frame: Int64, localTime: Double)? {
        guard let startFrame = playerStartFrame, player.isPlaying,
              let nodeTime = player.lastRenderTime, nodeTime.isHostTimeValid, nodeTime.isSampleTimeValid,
              let playerTime = player.playerTime(forNodeTime: nodeTime), playerTime.sampleTime >= 0
        else { return nil }
        return (startFrame + playerTime.sampleTime, HostClock.seconds(forHostTicks: nodeTime.hostTime))
    }

    private func currentPlayerFrame() -> Int64? { currentRender()?.frame }

    // MARK: Control periódico

    private func tick() {
        defer { publishSnapshot() }
        guard let timeline, let offset = hostMinusLocal, playerStartFrame != nil else { return }

        // Cambió la ruta (otro parlante, otra latencia): reprogramar.
        let latency = currentOutputLatency()
        if abs(latency - appliedLatency) > 0.005 {
            resync()
            return
        }

        guard let render = currentRender() else { return }
        let expected = SyncMath.expectedFrame(atLocalRenderTime: render.localTime, timeline: timeline,
                                              hostMinusLocal: offset, outputLatency: appliedLatency,
                                              userDelay: userDelay)
        let error = (Double(render.frame) - expected) / format.sampleRate
        lastSyncError = error

        // Libera los bloques que ya sonaron.
        retained.removeAll { $0.endFrame < render.frame }

        switch drift.update(measuredError: error) {
        case .adjustRate(let rate):
            varispeed.rate = Float(rate)
        case .hardResync:
            resync()
        }
    }

    private func handleConfigurationChange() {
        ensureEngineRunning()
        if timeline != nil { resync() }
        publishSnapshot()
    }

    private func publishSnapshot() {
        let current = currentPlayerFrame()
        var s = Snapshot()
        s.isPlaying = timeline != nil && current != nil
        if let current, let end = lastScheduledEndFrame {
            s.bufferedSeconds = max(0, format.seconds(forFrames: end - current))
        }
        s.syncError = s.isPlaying ? lastSyncError : nil
        s.rate = Double(varispeed.rate)
        s.outputLatency = currentOutputLatency()
        s.droppedChunks = droppedChunks
        s.lastError = lastError
        snapshotLock.lock()
        _snapshot = s
        snapshotLock.unlock()
    }
}
