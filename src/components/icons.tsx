/**
 * Sidebar icons. Sourced from `react-icons` (Game Icons set)
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
import logoUrl from "../../src-tauri/icons/nightshift_icon_light.png";

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

export function PipetteIcon({ size = 16 }: { size?: number }) {
  return <GiEyedropper size={size} style={{ verticalAlign: "-0.15em" }} />;
}

export function NightShiftIcon() {
  return <img src={logoUrl} alt="Nightshift" width={40} height={40} />;
}
