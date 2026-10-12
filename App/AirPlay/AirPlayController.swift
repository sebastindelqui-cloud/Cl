import AVFoundation
import Combine

/// Modo AirPlay 2: un solo iPhone, varios parlantes *compatibles con AirPlay 2*.
///
/// Con la política `longFormAudio`, iOS permite que el usuario marque varios
/// parlantes AirPlay 2 en el selector de rutas y él mismo los mantiene
/// sincronizados. Es la única forma pública de que una app suene en varios
/// parlantes inalámbricos desde un solo iPhone. Los parlantes que solo tienen
/// Bluetooth no aparecen en ese selector como destinos múltiples.
@MainActor
final class AirPlayController: ObservableObject {
    let player = AVPlayer()
    @Published private(set) var itemName: String?
    @Published private(set) var isPlaying = false
    @Published var error: String?

    private var cancellables: Set<AnyCancellable> = []

    init() {
        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in self?.isPlaying = status == .playing }
            .store(in: &cancellables)
    }

    func activate() {
        AudioSessionManager.shared.configure(for: .airPlay)
    }

    func deactivate() {
        player.pause()
    }

    func handleImport(_ result: Result<URL, Error>) {
        do {
            let copy = try AudioFileSource.importCopy(of: result.get())
            player.replaceCurrentItem(with: AVPlayerItem(url: copy))
            itemName = copy.deletingPathExtension().lastPathComponent
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func togglePlayback() {
        guard player.currentItem != nil else {
            error = "Primero elige un archivo de audio."
            return
        }
        if isPlaying {
            player.pause()
        } else {
            player.play()
        }
    }
}
