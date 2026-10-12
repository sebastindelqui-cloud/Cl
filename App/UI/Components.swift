import SwiftUI
import AVKit

/// Botón del sistema para elegir la salida de audio (Bluetooth, AirPlay…).
///
/// Es la única forma pública de que una app cambie de parlante: abre el mismo
/// selector que el Centro de control. La app no puede conectar parlantes por
/// su cuenta; el emparejamiento se hace en Ajustes › Bluetooth.
struct RoutePickerButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = .label
        view.activeTintColor = .systemBlue
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

/// Fila con texto y el botón de rutas a la derecha.
struct RoutePickerRow: View {
    let title: String

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            RoutePickerButton()
                .frame(width: 44, height: 44)
                .accessibilityLabel(title)
        }
    }
}

struct StatusDot: View {
    let color: Color
    var body: some View {
        Circle().fill(color).frame(width: 10, height: 10)
    }
}

struct MetricRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
        .font(.footnote)
    }
}

/// Control de retardo que solo aplica el valor al soltar el dedo: cada
/// cambio reprograma el audio, así que no conviene hacerlo en cada pixel.
struct DelayControl: View {
    let value: Double
    let onCommit: (Double) -> Void

    @State private var draft: Double = 0
    @State private var editing = false

    private let range: ClosedRange<Double> = -0.1...0.4

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Retardo")
                Spacer()
                Text(Format.signedMilliseconds(editing ? draft : value)).monospacedDigit()
                Button { commit(value - 0.005) } label: { Image(systemName: "minus.circle") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Restar 5 milisegundos")
                Button { commit(value + 0.005) } label: { Image(systemName: "plus.circle") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Sumar 5 milisegundos")
            }
            Slider(value: $draft, in: range, step: 0.001) { isEditing in
                editing = isEditing
                if !isEditing { commit(draft) }
            }
        }
        .onAppear { draft = value }
        .onChange(of: value) { newValue in if !editing { draft = newValue } }
    }

    private func commit(_ newValue: Double) {
        let clamped = min(max(newValue, range.lowerBound), range.upperBound)
        draft = clamped
        onCommit(clamped)
    }
}

struct VolumeControl: View {
    let value: Float
    let onChange: (Float) -> Void
    @State private var draft: Float = 1

    var body: some View {
        HStack {
            Image(systemName: "speaker.fill").foregroundStyle(.secondary)
            Slider(value: $draft, in: 0...1)
                .onChange(of: draft) { onChange($0) }
            Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
        }
        .onAppear { draft = value }
    }
}

struct SyncIndicator: View {
    let quality: SyncQuality

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(color: quality.color)
            Text(quality.title).font(.headline)
            Spacer()
            switch quality {
            case .good(let e), .fair(let e), .poor(let e):
                Text("peor error \(Format.milliseconds(e))").font(.footnote).monospacedDigit()
                    .foregroundStyle(.secondary)
            default:
                EmptyView()
            }
        }
    }
}

struct IssueList: View {
    let issues: [String]
    var body: some View {
        ForEach(issues, id: \.self) { issue in
            Label(issue, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.orange)
        }
    }
}

enum Format {
    static func milliseconds(_ seconds: Double) -> String {
        String(format: "%.1f ms", seconds * 1000)
    }

    static func signedMilliseconds(_ seconds: Double) -> String {
        String(format: "%+.0f ms", seconds * 1000)
    }

    static func optionalMilliseconds(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "—" }
        return String(format: "%+.1f ms", seconds * 1000)
    }

    static func time(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
