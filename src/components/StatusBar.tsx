import { useProjectStore } from '../store/project'

export default function StatusBar() {
  const { isOpen, name, jobs } = useProjectStore()
  
  return (
    <div className="h-6 bg-primary-700 flex items-center px-4 text-xs">
      {isOpen ? (
        <>
          <span>{name}</span>
          <span className="mx-2">|</span>
          <span>{jobs.length} jobs</span>
          <div className="flex-1" />
          <span>Ln 0, Col 0</span>
          <span className="ml-4">UTF-8</span>
          <span className="ml-4">LF</span>
        </>
      ) : (
        <span className="text-gray-300">No project open</span>
      )}
    </div>
  )
}
