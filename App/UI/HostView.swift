import SwiftUI
import DualSoundCore

/// Pantalla del emisor: elige la música, controla los dos parlantes y
/// muestra el estado de sincronización.
struct HostView: View {
    @StateObject private var model = HostViewModel()
    @ObservedObject private var audio = AudioSessionManager.shared
    @State private var showingImporter = false
    @State private var showingReceiverPicker = false

    var body: some View {
        List {
            transportSection
            sourceSection
            speakerOneSection
            speakerTwoSection
            syncSection
            issuesSection
        }
        .navigationTitle("Emisor")
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.audio]) { result in
            model.handleImport(result)
        }
        .sheet(isPresented: $showingReceiverPicker) {
            ReceiverPickerSheet(model: model)
        }
        .onAppear { model.activate() }
        .onDisappear { model.deactivate() }
    }

    // MARK: Secciones

    private var transportSection: some View {
        Section {
            VStack(spacing: 12) {
                Text(model.snapshot.sourceName ?? "Sin audio seleccionado")
                    .font(.headline)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                Text(positionText)
                    .font(.subheadline).monospacedDigit()
                    .foregroundStyle(.secondary)
                Button(action: model.togglePlayback) {
                    Image(systemName: model.snapshot.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .resizable()
                        .frame(width: 72, height: 72)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .disabled(model.snapshot.sourceName == nil)
                .accessibilityLabel(model.snapshot.isPlaying ? "Pausar" : "Reproducir")
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }

    private var positionText: String {
        let position = Format.time(model.snapshot.positionSeconds)
        if let duration = model.snapshot.durationSeconds {
            return "\(position) / \(Format.time(duration))"
        }
        return position
    }

    private var sourceSection: some View {
        Section {
            Button {
                showingImporter = true
            } label: {
                Label("Elegir archivo de audio…", systemImage: "music.note")
            }
            Button(action: model.loadClickTrack) {
                Label("Pista de calibración (clics)", systemImage: "metronome")
            }
            if let error = model.loadError ?? model.snapshot.error {
                Label(error, systemImage: "xmark.octagon.fill").foregroundStyle(.red).font(.footnote)
            }
        } header: {
            Text("Audio")
        } footer: {
            Text("Archivos MP3, M4A, WAV, AIFF o FLAC de la app Archivos. Spotify y Apple Music no se pueden usar: su audio está protegido y iOS no lo entrega a otras apps.")
        }
    }

    private var speakerOneSection: some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                StatusDot(color: audio.hasBluetoothOutput ? .green : .orange).padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(audio.currentOutputDescription)
                    if !audio.hasBluetoothOutput {
                        Text("No hay un parlante Bluetooth activo. Empareja el parlante 1 en Ajustes › Bluetooth y selecciónalo con el botón.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            RoutePickerRow(title: "Seleccionar parlante 1")
            Toggle("Sonar en este iPhone", isOn: Binding(
                get: { model.snapshot.playsLocally },
                set: { model.setPlaysLocally($0) }
            ))
            if model.snapshot.playsLocally {
                VolumeControl(value: model.snapshot.localVolume, onChange: model.setLocalVolume)
                DelayControl(value: model.snapshot.localDelay, onCommit: model.setLocalDelay)
                MetricRow(label: "Latencia de salida (iOS)", value: Format.milliseconds(model.snapshot.local.outputLatency))
                MetricRow(label: "Error de sincronía", value: Format.optionalMilliseconds(model.snapshot.local.syncError))
            }
        } header: {
            Text("Parlante 1 · conectado a este iPhone")
        }
    }

    private var speakerTwoSection: some View {
        Section {
            ForEach(model.snapshot.receivers) { receiver in
                RemoteSpeakerCard(receiver: receiver, model: model)
            }
            Button {
                showingReceiverPicker = true
            } label: {
                Label(model.snapshot.receivers.isEmpty ? "Seleccionar parlante 2" : "Añadir otro receptor",
                      systemImage: "plus.circle")
            }
        } header: {
            Text("Parlante 2 · conectado a un receptor")
        } footer: {
            Text("iOS solo permite una salida Bluetooth por dispositivo. El parlante 2 se conecta por Bluetooth a otro iPhone, iPad o iPod touch que tenga DualSound abierto en modo Receptor, en el mismo WiFi.")
        }
    }

    private var syncSection: some View {
        Section {
            SyncIndicator(quality: model.syncQuality)
        } header: {
            Text("Sincronización")
        } footer: {
            Text("El error mide cuánto se aparta cada dispositivo del reloj común. La latencia interna de cada parlante Bluetooth no siempre la informa iOS con exactitud: reproduce la pista de calibración y ajusta el retardo hasta oír un solo clic, sin eco.")
        }
    }

    @ViewBuilder
    private var issuesSection: some View {
        let issues = audio.detectedIssues + [model.browseError].compactMap { $0 }
        if !issues.isEmpty || audio.lastRouteEvent != nil {
            Section("Avisos") {
                IssueList(issues: issues)
                if let event = audio.lastRouteEvent {
                    Label(event, systemImage: "info.circle").font(.footnote)
                }
            }
        }
    }
}

/// Tarjeta de un receptor remoto con su estado real informado por la red.
struct RemoteSpeakerCard: View {
    let receiver: HostStreamer.ReceiverInfo
    @ObservedObject var model: HostViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                StatusDot(color: stateColor)
                VStack(alignment: .leading) {
                    Text(receiver.name).font(.headline)
                    Text(stateText).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                Button(role: .destructive) { model.remove(receiver.id) } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Quitar receptor")
            }
            if let status = receiver.status, receiver.state == .connected {
                Label(status.outputName, systemImage: "hifispeaker.fill").font(.subheadline)
                VolumeControl(value: receiver.volume) { model.setVolume($0, receiver: receiver.id) }
                DelayControl(value: receiver.delay) { model.setDelay($0, receiver: receiver.id) }
                MetricRow(label: "Latencia de salida (iOS)", value: Format.milliseconds(Double(status.outputLatency)))
                MetricRow(label: "Error de sincronía", value: Format.optionalMilliseconds(Double(status.syncError)))
                MetricRow(label: "Reloj (ida y vuelta)",
                          value: status.clockSynchronized ? Format.milliseconds(Double(status.clockRoundTrip)) : "sincronizando…")
                MetricRow(label: "Audio en búfer", value: String(format: "%.2f s", status.bufferedSeconds))
                if status.droppedChunks > 0 {
                    MetricRow(label: "Bloques que llegaron tarde", value: "\(status.droppedChunks)")
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var stateText: String {
        switch receiver.state {
        case .connecting: return "Conectando…"
        case .connected: return receiver.status?.isPlaying == true ? "Conectado · reproduciendo" : "Conectado"
        case .reconnecting(let attempt, let reason):
            return "Reconectando (intento \(attempt))" + (reason.map { ": \($0)" } ?? "")
        case .incompatible(let message): return message
        }
    }

    private var stateColor: Color {
        switch receiver.state {
        case .connected: return .green
        case .connecting: return .blue
        case .reconnecting: return .orange
        case .incompatible: return .red
        }
    }
}

/// Lista de receptores DualSound encontrados en la red local.
struct ReceiverPickerSheet: View {
    @ObservedObject var model: HostViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if model.discovered.isEmpty {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Buscando receptores en la red…")
                        }
                    }
                    ForEach(model.discovered) { receiver in
                        Button {
                            model.connect(receiver)
                            dismiss()
                        } label: {
                            HStack {
                                Label(receiver.name, systemImage: "iphone.radiowaves.left.and.right")
                                Spacer()
                                if model.isAlreadyAdded(receiver) {
                                    Image(systemName: "checkmark").foregroundStyle(.secondary)
                                }
                            }
                        }
                        .disabled(model.isAlreadyAdded(receiver))
                    }
                    if let error = model.browseError {
                        Label(error, systemImage: "wifi.exclamationmark").foregroundStyle(.orange).font(.footnote)
                    }
                } footer: {
                    Text("En el otro dispositivo: conecta el parlante 2 por Bluetooth, abre DualSound y elige «Receptor». Ambos deben estar en el mismo WiFi (o cerca, con WiFi y Bluetooth activados) y con el permiso de Red local concedido.")
                }
            }
            .navigationTitle("Parlante 2")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
    }
}
