import { useState } from 'react'
import Modal from './Modal'

interface InferenceJobFormProps {
  isOpen: boolean
  onClose: () => void
}

export default function InferenceJobForm({ isOpen, onClose }: InferenceJobFormProps) {
  const [config, setConfig] = useState({
    name: '',
    templatePath: '',
    inputFiles: [],
    provider: {
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      apiKey: '',
      temperature: 0.7,
      maxTokens: 1024,
    },
    sampling: {
      strategy: 'single' as const,
      sampleCount: 10,
    },
    outputFormat: 'unstructured' as const,
  })

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Inference Job">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Job Name</label>
          <input
            type="text"
            value={config.name}
            onChange={(e) => setConfig({ ...config, name: e.target.value })}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            placeholder="My Inference Job"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Jinja Template</label>
          <input
            type="text"
            value={config.templatePath}
            onChange={(e) => setConfig({ ...config, templatePath: e.target.value })}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            placeholder="prompts/template.jinja"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Input Files (optional)</label>
          <input
            type="text"
            placeholder="data/input.json, data/input.csv..."
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Provider Base URL</label>
            <input
              type="text"
              value={config.provider.baseUrl}
              onChange={(e) => setConfig({
                ...config,
                provider: { ...config.provider, baseUrl: e.target.value }
              })}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Model</label>
            <input
              type="text"
              value={config.provider.model}
              onChange={(e) => setConfig({
                ...config,
                provider: { ...config.provider, model: e.target.value }
              })}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">API Key</label>
          <input
            type="password"
            value={config.provider.apiKey}
            onChange={(e) => setConfig({
              ...config,
              provider: { ...config.provider, apiKey: e.target.value }
            })}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            placeholder="sk-..."
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Temperature</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={config.provider.temperature}
              onChange={(e) => setConfig({
                ...config,
                provider: { ...config.provider, temperature: parseFloat(e.target.value) }
              })}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Max Tokens</label>
            <input
              type="number"
              value={config.provider.maxTokens}
              onChange={(e) => setConfig({
                ...config,
                provider: { ...config.provider, maxTokens: parseInt(e.target.value) }
              })}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Sampling Strategy</label>
          <select
            value={config.sampling.strategy}
            onChange={(e) => setConfig({
              ...config,
              sampling: { ...config.sampling, strategy: e.target.value as any }
            })}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
          >
            <option value="single">Single</option>
            <option value="random">Random</option>
            <option value="exhaustive">Exhaustive</option>
          </select>
        </div>

        {config.sampling.strategy === 'random' && (
          <div>
            <label className="block text-sm font-medium mb-1">Sample Count</label>
            <input
              type="number"
              value={config.sampling.sampleCount}
              onChange={(e) => setConfig({
                ...config,
                sampling: { ...config.sampling, sampleCount: parseInt(e.target.value) }
              })}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-primary-500"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              // TODO: Submit job
              onClose()
            }}
            className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded"
          >
            Run Job
          </button>
        </div>
      </div>
    </Modal>
  )
}
