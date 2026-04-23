import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  js.configs.recommended,
  {
    plugins: { reactHooks, reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
]
