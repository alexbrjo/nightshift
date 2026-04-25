export default function NotImplemented({ feature }: { feature: string }) {
  return (
    <div className="p-8 text-center">
      <h2 className="text-xl font-semibold text-yellow-400">{feature} - Not Implemented</h2>
      <p className="mt-2 text-gray-400">This feature is under construction.</p>
    </div>
  );
}
