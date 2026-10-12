import Foundation
import SwiftUI
import UIKit
import DualSoundCore

/// Calidad de sincronización mostrada en la interfaz.
enum SyncQuality: Equatable {
    case idle
    case syncingClock
    case good(Double)
    case fair(Double)
    case poor(Double)

    /// Clasifica el peor error medido entre todos los parlantes activos.
    static func from(errors: [Double?], clockReady: Bool, playing: Bool) -> SyncQuality {
        guard playing else { return .idle }
        guard clockReady else { return .syncingClock }
        let measured = errors.compactMap { $0 }.filter { $0.isFinite }
        guard let worst = measured.map(abs).max() else { return .syncingClock }
        switch worst {
        case ..<0.005: return .good(worst)
        case ..<0.020: return .fair(worst)
        default: return .poor(worst)
        }
    }

    var title: String {
        switch self {
        case .idle: return "Detenido"
        case .syncingClock: return "Sincronizando reloj…"
        case .good: return "Sincronizado"
        case .fair: return "Ajustando"
        case .poor: return "Desfasado"
        }
    }

    var color: Color {
        switch self {
        case .idle: return .secondary
        case .syncingClock: return .blue
        case .good: return .green
        case .fair: return .orange
        case .poor: return .red
        }
    }
}

// MARK: - Emisor

@MainActor
final class HostViewModel: ObservableObject {
    @Published private(set) var snapshot = HostStreamer.Snapshot()
    @Published private(set) var discovered: [DiscoveredReceiver] = []
    @Published private(set) var browseError: String?
    @Published var loadError: String?

    private let streamer: HostStreamer
    private let browser: ReceiverBrowser

    init() {
        streamer = HostStreamer(hostName: UIDevice.current.name)
        browser = ReceiverBrowser(queue: streamer.queue)
        streamer.onChange = { [weak self] s in
            DispatchQueue.main.async { self?.snapshot = s }
        }
        browser.onChange = { [weak self] found in
            DispatchQueue.main.async { self?.discovered = found }
        }
        browser.onError = { [weak self] error in
            DispatchQueue.main.async { self?.browseError = error }
        }
    }

    func activate() {
        AudioSessionManager.shared.configure(for: .synchronized)
        browser.start()
    }

    func deactivate() {
        browser.stop()
        streamer.pause()
    }

    func handleImport(_ result: Result<URL, Error>) {
        do {
            let copy = try AudioFileSource.importCopy(of: result.get())
            streamer.load(try AudioFileSource(url: copy, format: streamer.format))
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    func loadClickTrack() {
        streamer.load(ClickTrackSource(format: streamer.format))
        loadError = nil
    }

    func togglePlayback() {
        snapshot.isPlaying ? streamer.pause() : streamer.play()
    }

    func connect(_ receiver: DiscoveredReceiver) { streamer.connect(to: receiver) }
    func remove(_ id: UUID) { streamer.removeReceiver(id: id) }
    func setVolume(_ v: Float, receiver id: UUID) { streamer.setReceiverVolume(id: id, volume: v) }
    func setDelay(_ d: Double, receiver id: UUID) { streamer.setReceiverDelay(id: id, delay: d) }
    func setLocalVolume(_ v: Float) { streamer.setLocalVolume(v) }
    func setLocalDelay(_ d: Double) { streamer.setLocalDelay(d) }
    func setPlaysLocally(_ on: Bool) { streamer.setPlaysLocally(on) }

    func isAlreadyAdded(_ receiver: DiscoveredReceiver) -> Bool {
        snapshot.receivers.contains { $0.name == receiver.name }
    }

    var syncQuality: SyncQuality {
        let connected = snapshot.receivers.filter { $0.state == .connected }
        var errors: [Double?] = connected.map { r in r.status.map { Double($0.syncError) } }
        if snapshot.playsLocally { errors.append(snapshot.local.syncError) }
        let clockReady = connected.allSatisfy { $0.status?.clockSynchronized == true }
        return .from(errors: errors, clockReady: clockReady, playing: snapshot.isPlaying)
    }
}

// MARK: - Receptor

@MainActor
final class ReceiverViewModel: ObservableObject {
    @Published private(set) var snapshot = ReceiverEngine.Snapshot()
    private let engine: ReceiverEngine

    init(name: String) {
        engine = ReceiverEngine(name: name)
        engine.onChange = { [weak self] s in
            DispatchQueue.main.async { self?.snapshot = s }
        }
    }

    func activate() {
        AudioSessionManager.shared.configure(for: .synchronized)
        engine.start()
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func deactivate() {
        engine.stop()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func rename(_ name: String) { engine.rename(name) }

    var syncQuality: SyncQuality {
        .from(errors: [snapshot.output.syncError], clockReady: snapshot.clockSynchronized,
              playing: snapshot.output.isPlaying)
    }
}
