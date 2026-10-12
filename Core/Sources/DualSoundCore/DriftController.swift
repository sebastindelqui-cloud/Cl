import Foundation

/// Corrige la deriva entre el reloj de audio de un dispositivo y la línea de
/// tiempo compartida.
///
/// Aunque los relojes estén sincronizados al iniciar, el hardware de audio de
/// cada dispositivo corre a una frecuencia ligeramente distinta (decenas de
/// partes por millón). En una hora eso acumula decenas de milisegundos, es
/// decir, eco audible. El controlador mide el error periódicamente y:
///
/// - Si el error es pequeño, ajusta la velocidad de reproducción apenas
///   (±0,2 % como máximo, inaudible) para corregirlo de forma continua.
/// - Si el error es grande (p. ej., tras un corte de red o un cambio de
///   parlante), pide una resincronización inmediata.
public struct DriftController: Sendable {
    public struct Configuration: Equatable, Sendable {
        /// Error por debajo del cual no se corrige nada (segundos).
        public var deadband: Double = 0.0015
        /// Corrección de velocidad por segundo de error. Con 0,25 un error de
        /// 4 ms produce una velocidad de 0,999 y se corrige en ~4 s.
        public var gain: Double = 0.25
        /// Desviación máxima de velocidad respecto de 1,0.
        public var maxRateAdjustment: Double = 0.002
        /// Error a partir del cual conviene reprogramar en vez de acelerar.
        public var hardResyncThreshold: Double = 0.040
        /// Suavizado exponencial de las mediciones (0…1, más alto = más rápido).
        public var smoothing: Double = 0.3

        public init() {}
    }

    public enum Action: Equatable, Sendable {
        case adjustRate(Double)
        case hardResync
    }

    public let configuration: Configuration
    public private(set) var smoothedError: Double?
    public private(set) var rate: Double = 1

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    /// - Parameter error: segundos que la reproducción va *adelantada*
    ///   respecto de lo esperado (negativo = atrasada).
    public mutating func update(measuredError error: Double) -> Action {
        let c = configuration
        guard error.isFinite else { return .adjustRate(rate) }
        if abs(error) > c.hardResyncThreshold {
            reset()
            return .hardResync
        }
        let smoothed = smoothedError.map { $0 + c.smoothing * (error - $0) } ?? error
        smoothedError = smoothed
        if abs(smoothed) < c.deadband {
            rate = 1
        } else {
            // Adelantada → más lento (rate < 1); atrasada → más rápido.
            let adjustment = min(max(c.gain * smoothed, -c.maxRateAdjustment), c.maxRateAdjustment)
            rate = 1 - adjustment
        }
        return .adjustRate(rate)
    }

    public mutating func reset() {
        smoothedError = nil
        rate = 1
    }
}
