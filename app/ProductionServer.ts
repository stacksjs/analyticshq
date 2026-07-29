import process from 'node:process'
import { startProductionServer } from '@stacksjs/buddy/production-server.js'

process.env.APP_ENV ||= 'production'
process.env.NODE_ENV ||= 'production'

await startProductionServer()
