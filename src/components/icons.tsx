/**
 * Sidebar icons. Sourced from `react-icons` (Game Icons set) so they render
 * as crisp, consistent line-art at small sizes. All icons use `currentColor`
 * by default, so they pick up the nav's foreground color (white when
 * inactive, accent-blue when active).
 *
 * To swap an icon, change the import here — App.tsx imports stay the same.
 */
import {
  GiEyedropper,
  GiNotebook,
  GiTestTubes,
  GiFizzingFlask,
} from "react-icons/gi";
import logoLightUrl from "../../src-tauri/icons/nightshift_icon_light.png";

const ICON_SIZE = 20;

export function DropperIcon() {
  return <GiEyedropper size={ICON_SIZE} />;
}

export function CabinetIcon() {
  return <GiNotebook size={ICON_SIZE} />;
}

export function TestTubeIcon() {
  return <GiTestTubes size={ICON_SIZE} />;
}

export function RackIcon() {
  return <GiFizzingFlask size={ICON_SIZE} />;
}

/** App logo for the sidebar header — striped-disk Nightshift mark (light
 *  variant for the blue rail). Sourced from src-tauri/icons so the same
 *  artwork is shared with the Tauri bundle. */
export function MoonIcon() {
  return <img src={logoLightUrl} alt="Nightshift" width={40} height={40} />;
}
