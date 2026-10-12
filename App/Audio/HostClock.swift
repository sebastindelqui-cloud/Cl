import AVFoundation
import Darwin

/// Reloj monotónico del dispositivo, en segundos.
///
/// Es el mismo reloj (`mach_absolute_time`) que usa Core Audio para
/// `AVAudioTime.hostTime`, de modo que los instantes calculados para la
/// sincronización se pueden pasar directamente a `AVAudioPlayerNode.play(at:)`.
enum HostClock {
    static func now() -> Double {
        AVAudioTime.seconds(forHostTime: mach_absolute_time())
    }

    static func hostTicks(forSeconds seconds: Double) -> UInt64 {
        AVAudioTime.hostTime(forSeconds: max(0, seconds))
    }

    static func seconds(forHostTicks ticks: UInt64) -> Double {
        AVAudioTime.seconds(forHostTime: ticks)
    }
}
