// Big render of one font for letterform inspection: node scripts/title-mesh/font-zoom.mjs russo-one
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const f = process.argv[2] || 'russo-one'
const b64 = fs.readFileSync(`node_modules/@fontsource/${f}/files/${f}-latin-400-normal.woff`).toString('base64')
const b = await chromium.launch({channel:'chrome',headless:true})
const p = await b.newPage({viewport:{width:1600,height:300}})
await p.setContent(`<style>@font-face{font-family:X;src:url(data:font/woff;base64,${b64})} body{margin:10px;background:#fff;font-family:X;font-size:220px;line-height:1;white-space:nowrap}</style>SLAVA VOLKOV`)
await p.waitForTimeout(500)
await p.screenshot({path:`shots/title-mesh/font_${f}.png`,fullPage:true})
await b.close()
