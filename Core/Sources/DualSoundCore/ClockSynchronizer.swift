import Foundation

/// Una medición de reloj estilo NTP.
///
/// - `t0`: el receptor envía el ping (reloj local).
/// - `t1`: el emisor recibe el ping (reloj del emisor).
/// - `t2`: el emisor responde (reloj del emisor).
/// - `t3`: el receptor recibe la respuesta (reloj local).
public struct ClockSample: Equatable, Sendable {
    public var t0: Double
    public var t1: Double
    public var t2: Double
    public var t3: Double

    public init(t0: Double, t1: Double, t2: Double, t3: Double) {
        self.t0 = t0
        self.t1 = t1
        self.t2 = t2
        self.t3 = t3
    }

    /// Tiempo de ida y vuelta de la red, sin contar el procesamiento del emisor.
    public var roundTrip: Double { (t3 - t0) - (t2 - t1) }

    /// Desfase estimado (reloj del emisor − reloj local), asumiendo que la ida
    /// y la vuelta tardan lo mismo.
    public var offset: Double { ((t1 - t0) + (t2 - t3)) / 2 }
}

/// Estima el desfase entre el reloj del receptor y el del emisor.
///
/// El error de una medición NTP está acotado por la mitad de su tiempo de ida
/// y vuelta, y en WiFi ese tiempo varía mucho (colas, ahorro de energía). Por
/// eso se usa el filtro de "mínimo RTT": de las últimas mediciones se toma la
/// que tuvo el viaje más corto, que es la menos contaminada por demoras. La
/// ventana es corta para seguir la deriva lenta entre los dos relojes.
public struct ClockSynchronizer: Sendable {
    public let windowSize: Int
    public let maxAcceptedRoundTrip: Double
    public let minimumSamples: Int

    private var samples: [ClockSample] = []

    public init(windowSize: Int = 20, maxAcceptedRoundTrip: Double = 0.25, minimumSamples: Int = 4) {
        precondition(windowSize > 0 && minimumSamples > 0)
        self.windowSize = windowSize
        self.maxAcceptedRoundTrip = maxAcceptedRoundTrip
        self.minimumSamples = minimumSamples
    }

    /// Agrega una medición. Devuelve `false` si se descartó por inválida.
    @discardableResult
    public mutating func add(_ sample: ClockSample) -> Bool {
        let rtt = sample.roundTrip
        guard rtt.isFinite, rtt >= 0, rtt <= maxAcceptedRoundTrip else { return false }
        samples.append(sample)
        if samples.count > windowSize {
            samples.removeFirst(samples.count - windowSize)
        }
        return true
    }

    public mutating func reset() {
        samples.removeAll()
    }

    public var sampleCount: Int { samples.count }

    /// Hay suficientes mediciones para confiar en el desfase.
    public var isSynchronized: Bool { samples.count >= minimumSamples }

    private var best: ClockSample? {
        samples.min(by: { $0.roundTrip < $1.roundTrip })
    }

    /// Desfase (reloj del emisor − reloj local), o `nil` si aún no hay
    /// suficientes mediciones.
    public var offset: Double? {
        guard isSynchronized else { return nil }
        return best?.offset
    }

    /// Menor tiempo de ida y vuelta de la ventana. La incertidumbre del
    /// desfase es como máximo la mitad de este valor.
    public var bestRoundTrip: Double? { best?.roundTrip }

    public func hostTime(fromLocal local: Double) -> Double? {
        offset.map { local + $0 }
    }

    public func localTime(fromHost host: Double) -> Double? {
        offset.map { host - $0 }
    }
}
