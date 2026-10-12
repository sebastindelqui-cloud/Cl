import SwiftUI

/// Pantalla del receptor: este dispositivo recibe la música del emisor y la
/// reproduce en su propio parlante Bluetooth.
struct ReceiverView: View {
    @AppStorage("receiverName") private var receiverName = "Receptor DualSound"
    @StateObject private var model: ReceiverViewModel
    @ObservedObject private var audio = AudioSessionManager.shared

    init() {
        let saved = UserDefaults.standard.string(forKey: "receiverName") ?? "Receptor DualSound"
        _model = StateObject(wrappedValue: ReceiverViewModel(name: saved))
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    StatusDot(color: stateColor)
                    Text(stateText).font(.headline)
                }
                if let event = model.snapshot.lastEvent {
                    Text(event).font(.footnote).foregroundStyle(.secondary)
                }
            } header: {
                Text("Estado")
            } footer: {
                Text("Deja esta pantalla abierta. En el iPhone emisor, toca «Seleccionar parlante 2» y elige este receptor.")
            }

            Section("Nombre visible en la red") {
                TextField("Nombre", text: $receiverName)
                    .submitLabel(.done)
                    .onSubmit { model.rename(receiverName) }
            }

            Section {
                HStack(spacing: 10) {
                    StatusDot(color: audio.hasBluetoothOutput ? .green : .orange)
                    Text(audio.currentOutputDescription)
                }
                RoutePickerRow(title: "Seleccionar parlante 2")
            } header: {
                Text("Parlante 2 · conectado a este dispositivo")
            } footer: {
                Text("Empareja el parlante en Ajustes › Bluetooth y elígelo como salida con el botón.")
            }

            Section {
                SyncIndicator(quality: model.syncQuality)
                MetricRow(label: "Reloj con el emisor",
                          value: model.snapshot.clockSynchronized
                            ? "±" + Format.milliseconds((model.snapshot.clockRoundTrip ?? 0) / 2)
                            : "sincronizando…")
                MetricRow(label: "Latencia de salida (iOS)", value: Format.milliseconds(model.snapshot.output.outputLatency))
                MetricRow(label: "Error de sincronía", value: Format.optionalMilliseconds(model.snapshot.output.syncError))
                MetricRow(label: "Corrección de velocidad",
                          value: String(format: "%+.3f %%", (model.snapshot.output.rate - 1) * 100))
                MetricRow(label: "Audio en búfer", value: String(format: "%.2f s", model.snapshot.output.bufferedSeconds))
                MetricRow(label: "Volumen / retardo (desde el emisor)",
                          value: String(format: "%.0f %% · ", model.snapshot.volume * 100)
                            + Format.signedMilliseconds(model.snapshot.delay))
                if model.snapshot.output.droppedChunks > 0 {
                    MetricRow(label: "Bloques que llegaron tarde", value: "\(model.snapshot.output.droppedChunks)")
                }
            } header: {
                Text("Sincronización")
            }

            let issues = audio.detectedIssues + [model.snapshot.output.lastError].compactMap { $0 }
            if !issues.isEmpty {
                Section("Avisos") { IssueList(issues: issues) }
            }
        }
        .navigationTitle("Receptor")
        .onAppear { model.activate() }
        .onDisappear { model.deactivate() }
    }

    private var stateText: String {
        switch model.snapshot.state {
        case .stopped: return "Detenido"
        case .advertising: return "Esperando al emisor…"
        case .connected(let host):
            return model.snapshot.output.isPlaying ? "Reproduciendo desde \(host)" : "Conectado a \(host)"
        case .failed(let message): return message
        }
    }

    private var stateColor: Color {
        switch model.snapshot.state {
        case .stopped: return .secondary
        case .advertising: return .blue
        case .connected: return .green
        case .failed: return .red
        }
    }
}
