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
  GiFiles,
  GiTestTubes,
  GiFizzingFlask,
  GiCheckboxTree,
} from "react-icons/gi";
import { FaCode, FaMarkdown, FaProjectDiagram } from "react-icons/fa";
import logoLightUrl from "../../src-tauri/icons/nightshift_icon_light.png";

const ICON_SIZE = 20;

/** Editor / Project: notebook with pen. */
export function DropperIcon() {
  return <GiNotebook size={ICON_SIZE} />;
}

/** Collections: stacked sheets of paper. */
export function CabinetIcon() {
  return <GiFiles size={ICON_SIZE} />;
}

export function TestTubeIcon() {
  return <GiTestTubes size={ICON_SIZE} />;
}

export function RackIcon() {
  return <GiFizzingFlask size={ICON_SIZE} />;
}

export function MethodIcon() {
  return <GiCheckboxTree size={ICON_SIZE} />;
}

export function CodeViewIcon({ size = 14 }: { size?: number }) {
  return <FaCode size={size} />;
}

export function MarkdownViewIcon({ size = 14 }: { size?: number }) {
  return <FaMarkdown size={size} />;
}

export function MethodGraphViewIcon({ size = 14 }: { size?: number }) {
  return <FaProjectDiagram size={size} />;
}

/** Inline pipette icon — used in action buttons. Inherits text color and
 *  sits flush with adjacent label text. */
export function PipetteIcon({ size = 16 }: { size?: number }) {
  return <GiEyedropper size={size} style={{ verticalAlign: "-0.15em" }} />;
}

/** App logo for the sidebar header — striped-disk Nightshift mark (light
 *  variant for the blue rail). Sourced from src-tauri/icons so the same
 *  artwork is shared with the Tauri bundle. */
export function MoonIcon() {
  return <img src={logoLightUrl} alt="Nightshift" width={40} height={40} />;
}
