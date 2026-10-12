import AVFoundation
import DualSoundCore

enum AudioFileSourceError: LocalizedError {
    case unreadable(String)
    case unsupportedFormat
    case protected

    var errorDescription: String? {
        switch self {
        case .unreadable(let reason):
            return "No se pudo abrir el archivo de audio: \(reason)"
        case .unsupportedFormat:
            return "El formato de este archivo no es compatible."
        case .protected:
            return "El archivo está protegido (DRM) y no se puede reproducir fuera de su app."
        }
    }
}

/// Decodifica un archivo de audio local (MP3, AAC/M4A, WAV, AIFF, FLAC, ALAC…)
/// al formato del flujo (Int16 entrelazado a 48 kHz) bajo demanda.
///
/// Solo funciona con archivos a los que la app tiene acceso legítimo. El audio
/// de Spotify, Apple Music u otras apps de streaming está cifrado y iOS no lo
/// expone a terceros, así que no puede usarse como fuente.
final class AudioFileSource: AudioSource {
    let format: StreamFormat
    let totalFrames: Int64?
    let displayName: String

    private let file: AVAudioFile
    private let converter: AVAudioConverter
    private let decodeFormat: AVAudioFormat
    private let sourceRate: Double
    /// Siguiente cuadro (en el formato del flujo) que devolverá el conversor.
    private var cursor: Int64 = 0
    private var reachedEnd = false

    init(url: URL, format: StreamFormat = .standard) throws {
        self.format = format
        displayName = url.deletingPathExtension().lastPathComponent
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            let ns = error as NSError
            // kAudioFileUnsupportedFileTypeError / kAudioFilePermissionsError
            if ns.code == 1_954_115_647 { throw AudioFileSourceError.unsupportedFormat }
            throw AudioFileSourceError.unreadable(error.localizedDescription)
        }
        let input = file.processingFormat
        sourceRate = input.sampleRate
        guard sourceRate > 0, input.channelCount > 0, file.length > 0 else {
            throw AudioFileSourceError.unsupportedFormat
        }
        // Mono se decodifica en mono y se duplica después: el conversor por
        // defecto dejaría el canal derecho en silencio.
        let decodeChannels: AVAudioChannelCount = input.channelCount == 1 ? 1 : 2
        guard let decodeFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: format.sampleRate,
                                               channels: decodeChannels, interleaved: true),
              let converter = AVAudioConverter(from: input, to: decodeFormat) else {
            throw AudioFileSourceError.unsupportedFormat
        }
        if input.channelCount > 2 { converter.downmix = true }
        self.decodeFormat = decodeFormat
        self.converter = converter
        totalFrames = Int64((Double(file.length) * format.sampleRate / sourceRate).rounded(.down))
    }

    func read(from frame: Int64, count: Int) throws -> [Int16]? {
        if frame != cursor { seek(to: frame) }
        if reachedEnd { return nil }

        guard let out = AVAudioPCMBuffer(pcmFormat: decodeFormat, frameCapacity: AVAudioFrameCount(count)) else {
            return nil
        }
        var conversionError: NSError?
        let status = converter.convert(to: out, error: &conversionError) { [file] packetCount, inputStatus in
            guard let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: packetCount) else {
                inputStatus.pointee = .endOfStream
                return nil
            }
            do {
                try file.read(into: input, frameCount: packetCount)
            } catch {
                inputStatus.pointee = .endOfStream
                return nil
            }
            if input.frameLength == 0 {
                inputStatus.pointee = .endOfStream
                return nil
            }
            inputStatus.pointee = .haveData
            return input
        }
        if status == .error {
            throw AudioFileSourceError.unreadable(conversionError?.localizedDescription ?? "error de conversión")
        }
        if status == .endOfStream { reachedEnd = true }

        let frames = Int(out.frameLength)
        guard frames > 0, let data = out.int16ChannelData else {
            reachedEnd = true
            return nil
        }
        cursor += Int64(frames)

        let decoded = data[0]
        if decodeFormat.channelCount == 1 {
            var stereo = [Int16](repeating: 0, count: frames * 2)
            for i in 0..<frames {
                stereo[2 * i] = decoded[i]
                stereo[2 * i + 1] = decoded[i]
            }
            return stereo
        }
        return Array(UnsafeBufferPointer(start: decoded, count: frames * 2))
    }

    private func seek(to frame: Int64) {
        let sourceFrame = AVAudioFramePosition((Double(max(0, frame)) * sourceRate / format.sampleRate).rounded())
        file.framePosition = min(sourceFrame, file.length)
        converter.reset()
        cursor = frame
        reachedEnd = false
    }
}

extension AudioFileSource {
    /// Copia un archivo elegido con el selector de Archivos al almacenamiento
    /// temporal de la app (los permisos de acceso del selector son temporales).
    static func importCopy(of pickedURL: URL) throws -> URL {
        let accessing = pickedURL.startAccessingSecurityScopedResource()
        defer { if accessing { pickedURL.stopAccessingSecurityScopedResource() } }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Importados", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(pickedURL.lastPathComponent)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: pickedURL, to: destination)
        return destination
    }
}
