import raccoonsDumpsterImage from "../../assets/raccoons_dumpster.png";

export default function EmptyWorkspace() {
  return (
    <div className="workspace-empty-state">
      <img
        className="workspace-empty-state-image"
        src={raccoonsDumpsterImage}
        alt=""
        aria-hidden="true"
      />
      <h2>Let's get started!</h2>
      <p>Create a chat, Method, job, or open a project file from the sidebar.</p>
    </div>
  );
}
