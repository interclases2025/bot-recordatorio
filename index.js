// index.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import express from 'express'

// ================== 🔧 Express Server (Railway) ==================
const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (req, res) => {
  res.send('✅ Bot WhatsApp activo en Railway 🚀')
})

app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP escuchando en puerto ${PORT}`)
})

// ================== 📂 Usuarios dinámicos ==================
let usuariosAutorizados = []

function cargarUsuarios() {
  try {
    const data = fs.readFileSync('usuarios.json', 'utf8')
    usuariosAutorizados = JSON.parse(data)
    console.log("✅ Usuarios autorizados recargados:", usuariosAutorizados)
  } catch (err) {
    console.error("⚠️ Error cargando usuarios.json:", err.message)
  }
}

// primera carga
cargarUsuarios()

// 🔄 Auto recargar usuarios si el archivo cambia
fs.watch('usuarios.json', (eventType) => {
  if (eventType === 'change') {
    console.log("🔄 Detectado cambio en usuarios.json, recargando...")
    cargarUsuarios()
  }
})

// ================== 📂 Recordatorios ==================
let recordatorios = {}
if (fs.existsSync('recordatorios.json')) {
  try {
    recordatorios = JSON.parse(fs.readFileSync('recordatorios.json'))
  } catch {
    recordatorios = {}
  }
}

let estados = {} // { numero: { paso, temp } }

function guardarRecordatorios() {
  fs.writeFileSync('recordatorios.json', JSON.stringify(recordatorios, null, 2))
}

// ================== 🛠️ Utilidades ==================
function getTextoMensaje(msg) {
  if (!msg.message) return null
  if (msg.message.conversation) return msg.message.conversation
  if (msg.message.extendedTextMessage) return msg.message.extendedTextMessage.text
  if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption
  return null
}

function normalizarJid(jid) {
  if (!jid) return null
  return jid.replace(/:.*$/, '')
}

function extraerNumero(jid) {
  if (!jid) return null
  return normalizarJid(jid)
}

function parsearFecha(texto) {
  const normalizado = texto.replace(" ", "T")
  const fecha = new Date(normalizado)
  if (isNaN(fecha.getTime())) return null
  return fecha
}

// ================== 🤖 Bot WhatsApp ==================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('session')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['RailwayBot', 'Chrome', '1.0']
  })

  // 📲 Mostrar QR
  sock.ev.on('connection.update', (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      console.log('📲 Escanea este QR con WhatsApp:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp')
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log('⚠️ Conexión cerrada, razón:', reason)

      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Reintentando conexión...')
        startBot()
      } else {
        console.log('❌ Sesión cerrada. Borra "session" y vuelve a enlazar.')
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // 📩 Manejo de mensajes
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const from = extraerNumero(msg.key.remoteJid)
    const text = getTextoMensaje(msg)?.trim()
    if (!text) return

    if (msg.key.fromMe) return // evitar loops

    console.log(`📨 ${from}: "${text}"`)

    // 🔒 Verificar permisos
    if (!usuariosAutorizados.includes(from)) {
      await sock.sendMessage(from, { text: '❌ No tienes permiso para usar este bot.' })
      return
    }

    if (!recordatorios[from]) recordatorios[from] = []
    if (!estados[from]) estados[from] = { paso: 'menu', temp: {} }
    const estado = estados[from]

    // ================== 📋 Menú ==================
    if (text.toLowerCase() === 'menu') {
      estado.paso = 'menu'
      await sock.sendMessage(from, {
        text: '📋 Menú principal:\n\n1️⃣ Añadir recordatorio\n2️⃣ Ver recordatorios\n3️⃣ Modificar recordatorios\n4️⃣ Calculadora (horas → minutos)'
      })
      return
    }

    // --- Menú ---
    if (estado.paso === 'menu') {
      if (text === '1') {
        estado.paso = 'nuevo_nombre'
        estado.temp = {}
        await sock.sendMessage(from, { text: '📝 Nombre del recordatorio:' })
      } else if (text === '2') {
        if (recordatorios[from].length === 0) {
          await sock.sendMessage(from, { text: '📂 No tienes recordatorios.' })
        } else {
          const lista = recordatorios[from].map((r, i) => `${i + 1}. ${r.nombre} 📅 ${r.fecha}`).join('\n')
          await sock.sendMessage(from, { text: `📌 Recordatorios:\n${lista}` })
        }
      } else if (text === '3') {
        if (recordatorios[from].length === 0) {
          await sock.sendMessage(from, { text: '📂 No tienes recordatorios para modificar.' })
        } else {
          estado.paso = 'modificar_elegir'
          const lista = recordatorios[from].map((r, i) => `${i + 1}. ${r.nombre}`).join('\n')
          await sock.sendMessage(from, { text: `✏️ Elige un recordatorio:\n${lista}` })
        }
      } else if (text === '4') {
        estado.paso = 'calculadora_horas'
        await sock.sendMessage(from, { text: '⌛ Ingresa cuántas horas quieres convertir a minutos:' })
      }
    }

    // ================== ➕ Añadir recordatorio ==================
    else if (estado.paso === 'nuevo_nombre') {
      estado.temp.nombre = text
      estado.paso = 'nuevo_fecha'
      await sock.sendMessage(from, { text: '📅 Fecha de entrega (YYYY-MM-DD HH:mm):' })
    } else if (estado.paso === 'nuevo_fecha') {
      const fecha = parsearFecha(text)
      if (!fecha) {
        await sock.sendMessage(from, { text: '❌ Fecha inválida. Usa: YYYY-MM-DD HH:mm' })
        return
      }
      estado.temp.fecha = fecha.toISOString()
      estado.paso = 'nuevo_intervalo'
      await sock.sendMessage(from, { text: '⏳ Intervalo de recordatorio (minutos):' })
    } else if (estado.paso === 'nuevo_intervalo') {
      const intervalo = parseInt(text)
      if (isNaN(intervalo) || intervalo <= 0) {
        await sock.sendMessage(from, { text: '❌ Intervalo inválido. Debe ser > 0.' })
        return
      }
      estado.temp.intervalo = intervalo
      estado.temp.proxima = Date.now() + intervalo * 60000
      recordatorios[from].push(estado.temp)
      guardarRecordatorios()
      estado.paso = 'menu'
      await sock.sendMessage(from, { text: '✅ Recordatorio guardado. Escribe "menu".' })
    }

    // ================== ⚙️ Modificar recordatorio ==================
    else if (estado.paso === 'modificar_elegir') {
      const idx = parseInt(text) - 1
      if (idx >= 0 && idx < recordatorios[from].length) {
        estado.temp.idx = idx
        estado.paso = 'modificar_menu'
        await sock.sendMessage(from, {
          text: `⚙️ Modificar "${recordatorios[from][idx].nombre}":\n\n1️⃣ Cambiar nombre\n2️⃣ Cambiar fecha\n3️⃣ Cambiar intervalo\n4️⃣ Borrar\n5️⃣ Salir`
        })
      } else {
        await sock.sendMessage(from, { text: '❌ Opción inválida.' })
      }
    } else if (estado.paso === 'modificar_menu') {
      const idx = estado.temp.idx
      if (text === '1') {
        estado.paso = 'modificar_nombre'
        await sock.sendMessage(from, { text: '📝 Nuevo nombre:' })
      } else if (text === '2') {
        estado.paso = 'modificar_fecha'
        await sock.sendMessage(from, { text: '📅 Nueva fecha (YYYY-MM-DD HH:mm):' })
      } else if (text === '3') {
        estado.paso = 'modificar_intervalo'
        await sock.sendMessage(from, { text: '⏳ Nuevo intervalo (minutos):' })
      } else if (text === '4') {
        recordatorios[from].splice(idx, 1)
        guardarRecordatorios()
        estado.paso = 'menu'
        await sock.sendMessage(from, { text: '🗑 Eliminado. Escribe "menu".' })
      } else if (text === '5') {
        estado.paso = 'menu'
        await sock.sendMessage(from, { text: '↩️ Volviendo al menú. Escribe "menu".' })
      }
    } else if (estado.paso === 'modificar_nombre') {
      recordatorios[from][estado.temp.idx].nombre = text
      guardarRecordatorios()
      estado.paso = 'menu'
      await sock.sendMessage(from, { text: '✅ Nombre actualizado. Escribe "menu".' })
    } else if (estado.paso === 'modificar_fecha') {
      const fecha = parsearFecha(text)
      if (!fecha) {
        await sock.sendMessage(from, { text: '❌ Fecha inválida. Usa: YYYY-MM-DD HH:mm' })
        return
      }
      recordatorios[from][estado.temp.idx].fecha = fecha.toISOString()
      guardarRecordatorios()
      estado.paso = 'menu'
      await sock.sendMessage(from, { text: '✅ Fecha actualizada. Escribe "menu".' })
    } else if (estado.paso === 'modificar_intervalo') {
      const intervalo = parseInt(text)
      if (isNaN(intervalo) || intervalo <= 0) {
        await sock.sendMessage(from, { text: '❌ Intervalo inválido.' })
        return
      }
      recordatorios[from][estado.temp.idx].intervalo = intervalo
      guardarRecordatorios()
      estado.paso = 'menu'
      await sock.sendMessage(from, { text: '✅ Intervalo actualizado. Escribe "menu".' })
    }

    // ================== 🧮 Calculadora ==================
    else if (estado.paso === 'calculadora_horas') {
      const horas = parseFloat(text)
      if (isNaN(horas) || horas < 0) {
        await sock.sendMessage(from, { text: '❌ Valor inválido. Ingresa un número válido de horas.' })
        return
      }
      const minutos = horas * 60
      await sock.sendMessage(from, { text: `⏳ ${horas} horas = ${minutos} minutos.` })
      estado.paso = 'menu'
    }
  })

  // ================== ⏰ Recordatorios ==================
  setInterval(async () => {
    const ahora = Date.now()
    for (const numero in recordatorios) {
      for (let i = 0; i < recordatorios[numero].length; i++) {
        const r = recordatorios[numero][i]
        const fechaEntrega = new Date(r.fecha).getTime()

        if (ahora >= fechaEntrega) {
          try {
            await sock.sendMessage(numero, { text: `✅ Entrega alcanzada para: ${r.nombre}` })
          } catch (err) {
            console.error("❌ Error enviando recordatorio final:", err.message)
          }
          recordatorios[numero].splice(i, 1)
          guardarRecordatorios()
          i--
          continue
        }

        if (ahora >= r.proxima && ahora < fechaEntrega) {
          try {
            await sock.sendMessage(numero, { text: `⏰ Recordatorio: ${r.nombre}` })
          } catch (err) {
            console.error("❌ Error enviando recordatorio:", err.message)
          }
          r.proxima = ahora + r.intervalo * 60000
          guardarRecordatorios()
        }
      }
    }
  }, 5000) // cada 5 segundos revisa
}

startBot()

// ================== 🛡️ Manejo de errores globales ==================
process.on('uncaughtException', (err) => {
  console.error('❌ Error no controlado:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada sin manejar:', reason)
})
