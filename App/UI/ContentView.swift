import SwiftUI

/// Pantalla inicial: el usuario elige el papel de este dispositivo.
struct ContentView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Reproduce la misma música en dos parlantes Bluetooth de cualquier marca. Como iOS solo permite **un** parlante Bluetooth por dispositivo, cada parlante se conecta a un dispositivo distinto y DualSound los sincroniza por WiFi.")
                        .font(.callout)
                }

                Section {
                    NavigationLink { HostView() } label: {
                        ModeRow(icon: "dot.radiowaves.left.and.right", title: "Emisor",
                                subtitle: "Este iPhone elige la música, suena en el parlante 1 y la envía al receptor.")
                    }
                    NavigationLink { ReceiverView() } label: {
                        ModeRow(icon: "hifispeaker.fill", title: "Receptor",
                                subtitle: "Este dispositivo recibe la música y la reproduce en el parlante 2.")
                    }
                } header: {
                    Text("Modo sincronizado · dos dispositivos")
                } footer: {
                    Text("Necesitas un segundo iPhone, iPad o iPod touch con DualSound para el parlante 2.")
                }

                Section {
                    NavigationLink { AirPlayView() } label: {
                        ModeRow(icon: "airplayaudio", title: "AirPlay 2",
                                subtitle: "Un solo iPhone y varios parlantes, solo si son compatibles con AirPlay 2.")
                    }
                } header: {
                    Text("Modo AirPlay · un dispositivo")
                }

                Section {
                    NavigationLink { LimitationsView() } label: {
                        Label("Limitaciones de iOS y compatibilidad", systemImage: "info.circle")
                    }
                }
            }
            .navigationTitle("DualSound")
        }
    }
}

struct ModeRow: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.title2)
                .frame(width: 36)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}
