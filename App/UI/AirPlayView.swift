import SwiftUI

/// Modo AirPlay 2: un solo iPhone y varios parlantes compatibles con AirPlay 2.
struct AirPlayView: View {
    @StateObject private var controller = AirPlayController()
    @ObservedObject private var audio = AudioSessionManager.shared
    @State private var showingImporter = false

    var body: some View {
        List {
            Section {
                Text("Si tus parlantes son compatibles con **AirPlay 2** (HomePod, Sonos y algunos modelos de Bose, JBL, Marshall, Bang & Olufsen o televisores), iOS puede enviar la misma música a varios a la vez y los sincroniza él mismo. Los parlantes que solo tienen Bluetooth no sirven para este modo.")
                    .font(.callout)
            }

            Section("Audio") {
                Button { showingImporter = true } label: {
                    Label(controller.itemName ?? "Elegir archivo de audio…", systemImage: "music.note")
                }
                Button(action: controller.togglePlayback) {
                    Label(controller.isPlaying ? "Pausar" : "Reproducir",
                          systemImage: controller.isPlaying ? "pause.fill" : "play.fill")
                }
                if let error = controller.error {
                    Label(error, systemImage: "xmark.octagon.fill").foregroundStyle(.red).font(.footnote)
                }
            }

            Section {
                RoutePickerRow(title: "Elegir parlantes AirPlay")
                ForEach(audio.outputs) { output in
                    Label("\(output.name) · \(output.kindDescription)", systemImage: "hifispeaker")
                }
            } header: {
                Text("Salidas activas")
            } footer: {
                Text("En el selector, marca la casilla de cada parlante AirPlay 2. Si solo aparece uno a la vez, ese parlante no admite AirPlay 2.")
            }
        }
        .navigationTitle("AirPlay 2")
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.audio]) { controller.handleImport($0) }
        .onAppear { controller.activate() }
        .onDisappear { controller.deactivate() }
    }
}
