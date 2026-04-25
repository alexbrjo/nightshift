export default function UnderConstruction({ title }: { title: string }) {
  return (
    <div className="under-construction">
      <div className="construction-icon">&#9881;</div>
      <h2>{title}</h2>
      <p>This section is under construction and will be available soon.</p>
    </div>
  );
}
