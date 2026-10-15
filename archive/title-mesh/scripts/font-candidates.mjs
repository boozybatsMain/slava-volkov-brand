// Renders candidate display fonts for letterform comparison with reference/title-main.jpg
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const fonts = ['russo-one','days-one','squada-one','changa-one','michroma']
const faces = fonts.map(f=>{
  const b64 = fs.readFileSync(`node_modules/@fontsource/${f}/files/${f}-latin-400-normal.woff`).toString('base64')
  return `@font-face{font-family:'${f}';src:url(data:font/woff;base64,${b64}) format('woff')}`
}).join('\n')
const rows = fonts.map(f=>`<div style="font-family:'${f}';font-size:110px;line-height:1.15;white-space:nowrap">SLAVA VOLKOV <span style="font-size:30px;font-family:monospace">${f}</span></div>`).join('')
const b = await chromium.launch({channel:'chrome',headless:true})
const p = await b.newPage({viewport:{width:1300,height:700}})
await p.setContent(`<style>${faces} body{margin:10px;background:#fff}</style>${rows}`)
await p.waitForTimeout(800)
await p.screenshot({path:'shots/title-mesh/font_candidates.png',fullPage:true})
await b.close()
