import React, { useState } from 'react'
import { AgentConfig } from '../../../common/models'

interface Props {
  onSave: (config: AgentConfig) => void;
}

const AgentForm: React.FC<Props> = ({ onSave }) => {
  const [name, setName] = useState('')
  const [queries, setQueries] = useState([''])
  const [summaryPrompt, setSummaryPrompt] = useState('')

  const addQuery = () => setQueries([...queries, ''])
  const updateQuery = (index: number, value: string) => {
    const newQueries = [...queries]
    newQueries[index] = value
    setQueries(newQueries)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({ name, queries, summaryPrompt })
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <div>
        <label>Agent Name:</label><br />
        <input 
          type="text" 
          value={name} 
          onChange={(e) => setName(e.target.value)} 
          required 
        />
      </div>

      <div>
        <label>Analysis Queries:</label>
        {queries.map((query, index) => (
          <div key={index} style={{ marginBottom: '5px' }}>
            <input 
              type="text" 
              value={query} 
              onChange={(e) => updateQuery(index, e.target.value)} 
              required 
            />
          </div>
        ))}
        <button type="button" onClick={addQuery}>Add Query</button>
      </div>

      <div>
        <label>Summary Prompt:</label><br />
        <textarea 
          value={summaryPrompt} 
          onChange={(e) => setSummaryPrompt(e.target.value)} 
          required 
          rows={5}
          style={{ width: '100%' }}
        />
      </div>

      <button type="submit">Create Agent</button>
    </form>
  )
}

export default AgentForm
