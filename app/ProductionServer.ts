import process from 'node:process'
import { serve } from '@stacksjs/buddy/commands/serve.js'
import { cli } from '@stacksjs/cli'

process.env.APP_ENV ||= 'production'
process.env.NODE_ENV ||= 'production'

const buddy = cli('buddy')
serve(buddy)

process.argv.splice(2, 0, 'serve')
await buddy.parse()
