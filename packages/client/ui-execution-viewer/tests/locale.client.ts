/** Translate seats for component and pure tests, mirroring the shipped dictionaries. */
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en, zh, type ExecutionTranslate } from '../src/client/locales.ts'

/** Build a translate seat over one dictionary. */
function translator(dictionary: Record<string, string>): ExecutionTranslate {
  return (key, params = {}) => {
    const template = dictionary[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params[name]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : ''
    })
  }
}

/** English Execution translator for component and format tests. */
export const t = translator({ ...commonEn, ...en })

/** Chinese Execution translator for tests that assert the shipped copy. */
export const tZh = translator({ ...commonZh, ...zh })
