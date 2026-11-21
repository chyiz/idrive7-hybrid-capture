# Hybrid Capture (`idrive7-hybrid-capture`)

A BMW iDrive 7 (`MGU`) diagnostic & signal-capture OAP app designed to investigate **PHEV Anticipatory Hybrid Drive (VEM / *Vorausschauendes Energiemanagement*)**, lower-speed highway ICE cut-in behavior in **Hybrid Eco Pro** (with coasting/sailing), and CarPlay vs. native BMW Navigation coexistence.

- **Zero external daemon dependencies** — renders using native BMW iDrive 7 full-width RHMI menus (`LT_State_Wide`), no `cluster-render` or `idrive7-renderd` required.
- **Background capture while driving** — open the app, start recording, then switch back to **Apple CarPlay** or **BMW Navigation** while all signal changes and ICE transitions keep logging.

---

## What It Captures

Subscribes to 16 SOME/IP interfaces (verified against G30 530e MGU `someip-interfaces.json`) and logs every state change plus 1 Hz snapshots and automatic **ICE start/stop cut-in events** to newline-delimited JSON (`JSONL`):

| Group | SOME/IP Interfaces & Key Fields |
|---|---|
| **Anticipatory Hybrid (VEM)** | `Efficiencytainment2` (`0xb517`): `statusSocHoldConfiguration` (`statusAdjustVEMVehicle`, `infoVemModeEvent`, target SoC), `statusAnticipatedModeHybrid` (`displayHybridForesightSituation`, distance bars), `statusOperatingModeHybrid` (`displayOperatingModeDriveHybrid`, SRA regen reason) |
| **ICE Start Reason & Coasting** | `Efficiencytainment` (`0xb506`): `statusReasonPowerUpCombustionEngine`, `statusPowerTrainSailing` (`SEGELN_AKTIV` / `SEGELN_MOEGLICH_PASSIV`), `backchannelDrivingmodeDxp` |
| **Drive Mode & EV Prevention** | `FES` (`0xb50d`): `statusFESVehicleDynamicSwitchHMI` (`PHEV_HYBRID_ECO`, `PHEV_BATTERYCONTROL`, etc.), `statusFESDriveStrategy` (`statusSetupBatteryControl`, `statusSetupPreferenceElectricDriveDriving`, sailing flags), `statusEDriveEVSystemState`, `statusElectricVehicleDriveSystemState` |
| **Powertrain & Range** | `Powertrain` (`0x9530`): `StatusCombustionEngine`; `Range` (`0x9500`): `dataRangeCalculation` (`currentRouteIntelligentRangeDisplay`), `dataRangeDisplay`; `Vehicle` (`0xb510`): `statusTripInformationElectricHybrid`, `statusMotorStartAuto`; `Vehicle2` (`0xb519`): speed; `CDS`: RPM & engine status; `KombiIF` (`0xb51b`): EV range & power split |
| **Navigation & Horizon Context** | `Guidance` (`0xfb1a`), `CarPlayManager`, `NavigationCAN` (`0xb524`), `ADAS` (`0xb51d` `resynchronisationNavigationGraph` — DME/EME/EGS resyncs), `ConnectedForesight` (`0xb54d` `EDriveZones`), `adasng.CCP` (`roadClass`, `urbanFlag`, `effectiveSpeedLimit`, `rampFlag`) |

---

## In-Car Workflow

1. Install **Hybrid Capture** via MGU Store (`chyiz/mgu-apps` **`develop`** channel).
2. Open **Apps → Hybrid Capture** and tap **Start Recording**.
3. Use the phase tag buttons to label each part of your highway drive:
   - **Tag Phase: Baseline (No Nav)** — drive at 50–65 MPH in **Hybrid Eco Pro** with no destination set.
   - **Tag Phase: BMW Nav (VEM)** — set a distant destination (> EV range) in built-in BMW Navigation with **Anticipatory Hybrid Drive** enabled.
   - **Tag Phase: CarPlay Nav** — drive with Apple CarPlay Maps active.
4. Tap **Mark Event (ICE Cut-In!)** anytime you notice an interesting switchover (automatic ICE start/stop transitions are also logged even while the app is in the background).
5. Tap **Stop Recording** (or simply park/turn off the car — `VehicleCondition` automatically flushes & stops recording).

### Experimental Write Probes (Disarmed by Default)

Open **Experimental Write Probes** and toggle **Arm Write Probes (Experimental)** only when you intentionally want to test:
- **Option 1A — BattCtrl Toggle ON + Sailing:** Sends `FES.fesDriveStrategy` (`operationToggleBatteryControl = LADEZUSTAND_HALTEN_AKTIVIEREN` + `operationAdjustSailingVehicle = SEGELN_ERLAUBT`) with all other fields set to unfilled defaults, then logs live readback 1.8 s later to verify whether G30 stays in `PHEV_HYBRID_ECO` with coasting or switches to `PHEV_BATTERYCONTROL`.
- **Option 1B — Set Target SoC = Current %:** Sets `Efficiencytainment2.socHoldConfiguration.operationDestinationSOCBatterysave` to current HV SoC rounded down to the nearest 10% (clamped 30–100%).
- **Option 1C — EV Drive Pref (`AUS` / `AN`):** Tests `FES.fesDriveStrategy.operationSetupPreferenceElectricDriveDriving`.
- **Option 3 — Fake KombiIF Route Forecast:** Periodically sends a synthetic long-route `ECO_PRO` forecast on `KombiIF.routeDestinationElectricHybrid` (`0xb51b`) to test whether `currentRouteIntelligentRangeDisplay` or VEM reacts without touching `NavGraph2` (`0xb51d`).

---

## Pulling Captures & Sniffing Outbound NavGraph2 (`0xb51d`)

Every active capture is stored in `<oap_data>/captures/capture-<ts>.jsonl` (auto-capped at 2 MiB / 10 files) and mirrored world-readably to **`/tmp/hybrid-capture-latest.jsonl`**:

```sh
# Pull the latest OAP capture over ENET SSH
scp -i <your_mgu_key> root@169.254.123.42:/tmp/hybrid-capture-latest.jsonl ./capture.jsonl

# Run the offline comparison & ICE cut-in analyzer
node scripts/analyze-capture.js ./capture.jsonl
```

To also capture **outbound** `MGU -> BDC/DME/EME` SOME/IP packets on `0xb51d` (`navigation.ADAS` / NavGraph2) and `0xb51b` (`KombiIF.routeDestinationElectricHybrid`) — which OAP apps cannot subscribe to directly (`getter.id = 0`) — run the companion SSH capture script on the MGU while switching between No-Nav and BMW-Nav:

```sh
ssh -i <your_mgu_key> root@169.254.123.42 'sh -s 120' < scripts/capture-mgu-adas.sh
scp -i <your_mgu_key> root@169.254.123.42:/tmp/adas-vem-capture.pcap .
```

---

## Build & Test

```sh
npm run build
npm test
```

## License

Licensed under the **GNU General Public License v3.0 (GPL-3.0)** — see [LICENSE](LICENSE).
