import SwiftUI

/// Explica qué permite iOS y muestra las incompatibilidades detectadas en
/// este dispositivo. Ver también docs/LIMITACIONES.md.
struct LimitationsView: View {
    @ObservedObject private var audio = AudioSessionManager.shared

    private let facts: [(title: String, body: String)] = [
        ("Una sola salida Bluetooth",
         "iOS envía el audio a un único parlante Bluetooth (A2DP) a la vez. Ninguna API pública permite a una app elegir dos salidas A2DP simultáneas, y AVAudioSession no ofrece esa opción."),
        ("Core Bluetooth no transmite música",
         "Core Bluetooth solo da acceso a Bluetooth de baja energía (GATT) para datos. No puede enviar audio a un parlante A2DP; el audio Bluetooth lo gestiona exclusivamente el sistema."),
        ("Modo multirruta",
         "La categoría multiRoute de AVAudioSession reparte audio entre salidas como USB, HDMI o audífonos con cable, pero no entre dos parlantes Bluetooth."),
        ("Bluetooth LE Audio / Auracast",
         "Apple no ofrece una API pública para que una app emita audio LE Audio ni Auracast hacia varios parlantes. Además, la mayoría de los parlantes actuales no lo soportan."),
        ("«Compartir audio» de Apple",
         "Solo funciona con dos AirPods o audífonos Beats compatibles, no con parlantes de otras marcas."),
        ("AirPlay 2",
         "Una app sí puede sonar en varios parlantes AirPlay 2 a la vez (modo AirPlay de DualSound), pero los parlantes que solo tienen Bluetooth no son compatibles."),
        ("Spotify y Apple Music",
         "Su audio está protegido (DRM) y iOS no permite que otra app lo capture o reenvíe. DualSound solo reproduce archivos de audio propios."),
        ("La solución de DualSound",
         "Cada parlante Bluetooth se conecta a un dispositivo iOS distinto. El emisor reparte el audio por WiFi con marcas de tiempo y ambos dispositivos lo reproducen al mismo instante, compensando la latencia y la deriva de los relojes."),
    ]

    var body: some View {
        List {
            Section("Detectado en este dispositivo") {
                Label(audio.currentOutputDescription, systemImage: "speaker.wave.2")
                if audio.detectedIssues.isEmpty {
                    Label("Sin incompatibilidades en la salida actual.", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                } else {
                    IssueList(issues: audio.detectedIssues)
                }
                MetricRow(label: "Latencia de salida informada", value: Format.milliseconds(audio.outputLatency))
            }

            Section("Qué permite iOS") {
                ForEach(facts, id: \.title) { fact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(fact.title).font(.headline)
                        Text(fact.body).font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle("Limitaciones")
        .onAppear { audio.refresh() }
    }
}
