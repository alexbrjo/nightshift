import React, { useState } from 'react'
import { BulkActionConfig } from '../../../common/models'

interface Props {
  onSave: (config: BulkActionConfig) => void;
}

const BulkActionForm: React.FC<Props> = ({ onSave }) => {
  const [config, setConfig] = useState<BulkActionConfig>({
    name: '',
    sourceCollectionId: '',
    targetCollectionId: '',
    scriptPath: '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(config)
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <div>
        <label>Action Name:</label><br />
        <input 
          type="text" 
          value={config.name} 
          onChange={(e) => setConfig({ ...config, name: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Source Collection ID:</label><br />
        <input 
          type="text" 
          value={config.sourceCollectionId} 
          onChange={(e) => setConfig({ ...config, sourceCollectionId: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Target Collection ID:</label><br />
        <input 
          type="text" 
          value={config.targetCollectionId} 
          onChange={(e) => setConfig({ ...config, targetCollectionId: e.target.value })} 
          required 
        />
      </div>

      <div>
        <label>Action Script Path:</label><br />
        <input 
          type="text" 
          value={config.scriptPath} 
          onChange={(e) => setConfig({ ...config, scriptPath: e.target.value })} 
          required 
        />
      </div>

      <button type="submit">Create Bulk Action</button>
    </form>
  )
}

export default BulkActionForm
