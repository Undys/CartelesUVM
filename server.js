const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns');
const nodemailer = require('nodemailer');

// Priorizar IPv4 globalmente para evitar retrasos de 30-60s por timeouts de IPv6 al conectar a Gmail/SMTP desde servidores en la nube
if (typeof dns.setDefaultResultOrder === 'function') {
    try {
        dns.setDefaultResultOrder('ipv4first');
    } catch (e) {}
}

// Cargar variables de entorno desde .env (evita exponer credenciales en GitHub)
if (typeof process.loadEnvFile === 'function') {
    try {
        process.loadEnvFile();
    } catch (e) {
        // El archivo .env es opcional en tiempo de ejecución
    }
} else if (fs.existsSync(path.join(__dirname, '.env'))) {
    try {
        const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        envContent.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const idx = trimmed.indexOf('=');
                if (idx > -1) {
                    const k = trimmed.substring(0, idx).trim();
                    const v = trimmed.substring(idx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
                    if (k && !process.env[k]) process.env[k] = v;
                }
            }
        });
    } catch (e) {
        console.warn('Advertencia al procesar .env:', e.message);
    }
}

const app = express();
app.use(express.json());
app.use(cors());

// Identificador único de arranque del servidor: cambia cada vez que se cierra/reinicia el servidor
const SERVER_BOOT_ID = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');

// Evitar caché del navegador en páginas HTML para que al cerrar y volver a abrir nunca regrese a vistas anteriores
function enviarIndexSinCache(req, res) {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
}

app.get('/', enviarIndexSinCache);
app.get('/index.html', enviarIndexSinCache);
app.get('/jueces', enviarIndexSinCache);
app.get('/profesores', enviarIndexSinCache);
app.get('/admin', enviarIndexSinCache);

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Solo se permiten archivos PDF'));
    }
});

// Endpoint ligero para verificar si el servidor sigue activo o fue reiniciado
app.get('/api/estado-servidor', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ activo: true, boot_id: SERVER_BOOT_ID });
});

// Helper para obtener la URL base del servidor (para incluir enlaces en los correos)
function obtenerUrlBase(req) {
    if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) {
        return process.env.PUBLIC_URL.trim().replace(/\/+$/, '');
    }
    if (req && typeof req.get === 'function' && req.get('host')) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        return `${proto}://${req.get('host')}`;
    }
    const port = process.env.PORT || 3000;
    return `http://localhost:${port}`;
}

// Helper para convertir nombres y apellidos a mayúscula inicial (Title Case)
function capitalizarNombre(str) {
    if (!str) return '';
    return str.replace(/\b([a-záéíóúñü])([a-záéíóúñü]*)/gi, (m, primera, resto) => {
        return primera.toUpperCase() + resto.toLowerCase();
    });
}

// Helper para convertir nombres de alumnos a MAYÚSCULAS COMPLETAS (Requerimiento: gabriel guerrero -> GABRIEL GUERRERO)
function convertirMayusculas(str) {
    if (!str) return '';
    return str.trim().toUpperCase();
}

// Helper para generar claves únicas de carteles
function generarClaveAleatoria() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo = '';
    for (let i = 0; i < 4; i++) {
        codigo += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CART-${codigo}`;
}

// =========================================================================
// RÚBRICA OFICIAL PARA EVALUACIÓN DE CARTELES DE INVESTIGACIÓN (12 CRITERIOS)
// Estructurada para operar en escala de 1 a 5 estrellas con equivalencia en
// 3 niveles de desempeño y adaptable a escala de 3 niveles (escala_max: 3).
// =========================================================================
const RUBRICA_EVALUACION = {
    modo_escala: '5_estrellas', // Puede ajustarse a '3_niveles' (cambiando escala_max a 3)
    escala_max: 5,
    niveles_equivalencia: [
        {
            id: 'inicial',
            rango_5: [1, 2],
            valor_3: 1,
            etiqueta_5: '1 - 2 Estrellas',
            etiqueta_3: 'Nivel 1',
            nombre: 'Nivel Inicial',
            descripcion: 'Desempeño básico, poco delimitado, ausente o superficial.'
        },
        {
            id: 'intermedio',
            rango_5: [3, 4],
            valor_3: 2,
            etiqueta_5: '3 - 4 Estrellas',
            etiqueta_3: 'Nivel 2',
            nombre: 'Nivel Intermedio',
            descripcion: 'Desempeño claro, estructurado y funcional, con oportunidades de mejora.'
        },
        {
            id: 'avanzado',
            rango_5: [5, 5],
            valor_3: 3,
            etiqueta_5: '5 Estrellas',
            etiqueta_3: 'Nivel 3',
            nombre: 'Nivel Avanzado',
            descripcion: 'Desempeño excelente, riguroso, innovador, profundo y con alto impacto.'
        }
    ],
    criterios: [
        { id: 'r1', numero: 1, titulo: 'Problema de investigación', peso: 5, descripcion: 'Delimitación y contextualización de la problemática.' },
        { id: 'r2', numero: 2, titulo: 'Objetivos y justificación', peso: 10, descripcion: 'Claridad, enfoque estratégico e impacto de los objetivos.' },
        { id: 'r3', numero: 3, titulo: 'Marco teórico, citas y referencias', peso: 10, descripcion: 'Calidad de la literatura, citas y análisis crítico.' },
        { id: 'r4', numero: 4, titulo: 'Metodología', peso: 15, descripcion: 'Coherencia, validación y aplicación del diseño metodológico.' },
        { id: 'r5', numero: 5, titulo: 'Resultados', peso: 15, descripcion: 'Validez, solidez y completitud de los hallazgos.' },
        { id: 'r6', numero: 6, titulo: 'Aplicación del conocimiento', peso: 5, descripcion: 'Integración sólida de saberes previos y adquiridos.' },
        { id: 'r7', numero: 7, titulo: 'Análisis e interpretación', peso: 15, descripcion: 'Profundidad en el análisis crítico y discusión de datos.' },
        { id: 'r8', numero: 8, titulo: 'Resolución de problema real', peso: 5, descripcion: 'Relevancia y vigencia de la problemática abordada.' },
        { id: 'r9', numero: 9, titulo: 'Impacto y transferencia', peso: 10, descripcion: 'Propuesta de producto, prototipo o transferencia del conocimiento.' },
        { id: 'r10', numero: 10, titulo: 'Originalidad e innovación', peso: 10, descripcion: 'Valor agregado y elementos novedosos del proyecto.' },
        { id: 'r11', numero: 11, titulo: 'Presentación visual', peso: 5, descripcion: 'Diseño del cartel (organización, atractivo visual y claridad).' },
        { id: 'r12', numero: 12, titulo: 'Comunicación oral y dominio', peso: 5, descripcion: 'Claridad, seguridad y dominio del tema al exponer.' }
    ]
};

function calcularPuntajeRubrica(datos) {
    const maxEscala = RUBRICA_EVALUACION.escala_max;
    const valores = {};
    const sumaTotalPesos = RUBRICA_EVALUACION.criterios.reduce((acc, c) => acc + (Number(c.peso) || 0), 0) || 100;
    let sumaPonderadaEstrellas = 0;

    for (const crit of RUBRICA_EVALUACION.criterios) {
        const val = parseInt(datos[crit.id]);
        if (isNaN(val) || val < 1 || val > maxEscala) {
            return {
                valido: false,
                error: `El criterio "${crit.numero}. ${crit.titulo}" debe calificarse en la escala de 1 a ${maxEscala}.`
            };
        }
        valores[crit.id] = val;
        sumaPonderadaEstrellas += val * (crit.peso / sumaTotalPesos);
    }

    const estrellasPonderadas = Math.round(sumaPonderadaEstrellas * 100) / 100;
    const calificacionPonderada100 = Math.round(((sumaPonderadaEstrellas / maxEscala) * 100) * 100) / 100;

    return {
        valido: true,
        escala_max: maxEscala,
        valores,
        estrellas_ponderadas: estrellasPonderadas,
        puntaje_total: calificacionPonderada100
    };
}

app.get('/api/rubrica', (req, res) => {
    res.json(RUBRICA_EVALUACION);
});

// Caché de configuración y transporter SMTP con pool de conexiones para envío instantáneo
let smtpConfigCache = null;
let smtpConfigCacheTime = 0;
let smtpTransporterPool = null;
let smtpTransporterKey = '';
let smtpTcpBloqueadoEnServidor = false;

function invalidarCacheSmtp() {
    smtpConfigCache = null;
    smtpConfigCacheTime = 0;
    smtpTcpBloqueadoEnServidor = false;
    if (smtpTransporterPool && typeof smtpTransporterPool.close === 'function') {
        try { smtpTransporterPool.close(); } catch (e) {}
    }
    smtpTransporterPool = null;
    smtpTransporterKey = '';
}

// Helper para obtener la configuración SMTP activa (primero desde la base de datos configurada en el Panel Admin y luego desde .env)
async function obtenerConfiguracionSmtp(forzarRecarga = false) {
    const ahora = Date.now();
    if (!forzarRecarga && smtpConfigCache && (ahora - smtpConfigCacheTime < 60000)) {
        return smtpConfigCache;
    }

    let dbCfg = null;
    if (pool) {
        try {
            const [rows] = await pool.query('SELECT * FROM configuracion_smtp WHERE id = 1 LIMIT 1');
            if (rows.length > 0 && ((rows[0].smtp_user && rows[0].smtp_pass) || rows[0].webhook_url)) {
                dbCfg = rows[0];
            }
        } catch (e) {}
    }

    const rawUser = dbCfg ? dbCfg.smtp_user : (process.env.SMTP_USER || '');
    const rawPass = dbCfg ? dbCfg.smtp_pass : (process.env.SMTP_PASS || '');
    const rawHost = dbCfg ? dbCfg.smtp_host : (process.env.SMTP_HOST || '');
    const rawPort = dbCfg ? dbCfg.smtp_port : (process.env.SMTP_PORT || '');
    const rawFrom = dbCfg ? dbCfg.smtp_from : (process.env.SMTP_FROM || '');
    const rawWebhook = (dbCfg && dbCfg.webhook_url) ? dbCfg.webhook_url : (process.env.SMTP_WEBHOOK_URL || '');

    const smtpUser = (rawUser || '').trim();
    const smtpPass = (rawPass || '').trim().replace(/\s+/g, '');
    const webhookUrl = (rawWebhook || '').trim();
    let smtpHost = (rawHost || 'smtp.gmail.com').trim();
    if (smtpUser.toLowerCase().endsWith('@gmail.com')) {
        smtpHost = 'smtp.gmail.com';
    }
    const smtpPort = parseInt(rawPort) || 465;
    const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;
    const smtpFrom = (rawFrom && rawFrom.trim()) ? rawFrom.trim() : `"Sistema de Carteles UVM" <${smtpUser || 'notificaciones@uvm.edu.mx'}>`;

    const resultado = {
        smtpHost,
        smtpPort,
        smtpSecure,
        smtpUser,
        smtpPass,
        smtpFrom,
        webhookUrl,
        configurado: Boolean(webhookUrl || (smtpUser && smtpPass)),
        origen: dbCfg ? 'panel_admin' : ((webhookUrl || (smtpUser && smtpPass)) ? 'env' : 'ninguno')
    };

    smtpConfigCache = resultado;
    smtpConfigCacheTime = ahora;
    return resultado;
}

function obtenerTransporterSmtp(cfg, puertoOverride = null) {
    const port = puertoOverride || cfg.smtpPort || 465;
    const secure = (port === 465);
    const key = `${cfg.smtpHost}:${port}:${cfg.smtpUser}:${cfg.smtpPass}`;

    if (!puertoOverride && smtpTransporterPool && smtpTransporterKey === key) {
        return smtpTransporterPool;
    }

    const nuevoTransporter = nodemailer.createTransport({
        pool: false,
        host: cfg.smtpHost,
        port,
        secure,
        requireTLS: port === 587,
        family: 4, // Forzar IPv4 para evitar retrasos de 30s+ por IPv6 en contenedores cloud
        connectionTimeout: 2200,
        greetingTimeout: 2200,
        socketTimeout: 4000,
        auth: {
            user: cfg.smtpUser,
            pass: cfg.smtpPass
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    if (!puertoOverride) {
        smtpTransporterPool = nuevoTransporter;
        smtpTransporterKey = key;
    }
    return nuevoTransporter;
}

// Helper para normalizar números de teléfono celular (México +52 por defecto para WhatsApp si son 10 dígitos)
function normalizarTelefono(raw) {
    if (!raw) return '';
    const limpio = String(raw).replace(/[^\d+]/g, '');
    return limpio;
}

function obtenerTelefonoParaWhatsApp(telefonoLimpio) {
    const soloDigitos = String(telefonoLimpio || '').replace(/\D/g, '');
    if (!soloDigitos) return '';
    if (soloDigitos.length === 10) {
        return `52${soloDigitos}`;
    }
    return soloDigitos;
}

// Helper para generar los datos y enlaces de SMS directo / WhatsApp en 1 clic (instantáneo, sin demoras de red)
function generarDatosSmsCuenta({ telefono, email, nombre, matricula, password, rol, carrera, nivel_asignado, baseUrl }) {
    const urlServidor = (baseUrl || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const enlaceAcceso = rol === 'profesor'
        ? `${urlServidor}/jueces?usuario=${encodeURIComponent(matricula)}`
        : (rol === 'admin' ? `${urlServidor}/admin` : `${urlServidor}/`);

    const telLimpio = normalizarTelefono(telefono || email || '');
    const telWa = obtenerTelefonoParaWhatsApp(telLimpio);

    const textoSms = rol === 'profesor'
        ? `UVM Carteles - Hola ${nombre}, tus datos de Juez Evaluador (Nivel ${nivel_asignado || 1} - ${carrera || 'General'}):\nUsuario: ${matricula}\nClave: ${password}\nIngresa aqui: ${enlaceAcceso}`
        : `UVM Carteles - Hola ${nombre}, tus datos de acceso:\nUsuario: ${matricula}\nClave: ${password}\nIngresa aqui: ${enlaceAcceso}`;

    const bodyEncoded = encodeURIComponent(textoSms);
    const smsUrl = telLimpio ? `sms:${telLimpio}?body=${bodyEncoded}` : `sms:?body=${bodyEncoded}`;
    const whatsappUrl = telWa ? `https://wa.me/${telWa}?text=${bodyEncoded}` : `https://wa.me/?text=${bodyEncoded}`;

    return {
        enviado: false,
        listo_sms: Boolean(telLimpio),
        telefono: telLimpio,
        enlace_acceso: enlaceAcceso,
        mensaje_sms: textoSms,
        sms_url: smsUrl,
        whatsapp_url: whatsappUrl,
        datos_cuenta: {
            nombre,
            matricula,
            password,
            telefono: telLimpio,
            email: telLimpio,
            rol: rol || 'profesor',
            carrera: carrera || 'General',
            nivel_asignado: nivel_asignado || 1,
            enlace_acceso: enlaceAcceso,
            mensaje_sms: textoSms,
            sms_url: smsUrl,
            whatsapp_url: whatsappUrl
        }
    };
}

let pool;
async function conectarBD() {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = parseInt(process.env.DB_PORT) || (dbHost.includes('tidb') ? 4000 : 3306);
    const dbSslEnv = (process.env.DB_SSL || '').toLowerCase().trim();

    // Configuración SSL (exigida obligatoriamente por TiDB Cloud)
    let sslConfig = undefined;
    if (dbSslEnv === 'true' || dbSslEnv === '1' || dbSslEnv === 'yes') {
        sslConfig = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    } else if (dbSslEnv === 'false' || dbSslEnv === '0' || dbSslEnv === 'no') {
        sslConfig = undefined;
    } else if (dbHost !== 'localhost' && dbHost !== '127.0.0.1') {
        // En conexiones remotas / TiDB Cloud, habilitar SSL automáticamente
        sslConfig = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    }

    const poolConfig = {
        host: dbHost,
        port: dbPort,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'evaluaciones_db',
        waitForConnections: true,
        connectionLimit: 10
    };

    if (sslConfig) {
        poolConfig.ssl = sslConfig;
    }

    pool = mysql.createPool(process.env.DATABASE_URL || poolConfig);
    console.log(`Conectando a la base de datos (${dbHost}:${dbPort}${sslConfig ? ' con SSL/TLS' : ''})`);

    await asegurarEsquemaYColumnas();
}

let esquemaVerificado = false;
async function asegurarEsquemaYColumnas() {
    if (!pool) return;

    // Verificar conectividad a MySQL / TiDB antes de correr migraciones
    try {
        await pool.query('SELECT 1');
    } catch (connErr) {
        if (connErr.code === 'ER_BAD_DB_ERROR' && !process.env.DATABASE_URL) {
            try {
                const dbName = process.env.DB_NAME || 'evaluaciones_db';
                const tempConn = await mysql.createConnection({
                    host: process.env.DB_HOST || 'localhost',
                    port: parseInt(process.env.DB_PORT) || 3306,
                    user: process.env.DB_USER || 'root',
                    password: process.env.DB_PASSWORD || ''
                });
                await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
                await tempConn.end();
                console.log(`[OK] Base de datos '${dbName}' creada automáticamente.`);
            } catch (dbCreateErr) {
                console.warn('[AVISO BD] Error al crear base de datos:', dbCreateErr.message || dbCreateErr.code);
                return;
            }
        } else {
            const detalle = connErr.message || connErr.code || 'Error de conexión';
            console.warn(`[AVISO BD] No hay conexión activa con MySQL (${detalle}). Verifica que MySQL esté iniciado en XAMPP o revisa tu .env.`);
            return;
        }
    }

    // 0. Asegurar todas las tablas base si no existen
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS profesores (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(250) NOT NULL,
                email VARCHAR(150) NULL,
                carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería',
                nivel_asignado INT DEFAULT 1,
                password VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    } catch (e) {}

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS carteles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT NULL,
                nombre_equipo VARCHAR(250) NULL,
                participantes TEXT NULL,
                carrera VARCHAR(100) NOT NULL,
                semestre INT NOT NULL,
                nivel INT NOT NULL,
                titulo_cartel VARCHAR(255) NOT NULL,
                clave VARCHAR(50) NULL,
                archivo_url TEXT NULL,
                profesor_asesor_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    } catch (e) {}

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS asignaciones (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cartel_id INT NOT NULL,
                profesor_id INT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    } catch (e) {}

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS evaluaciones (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cartel_id INT NOT NULL,
                profesor_id INT NOT NULL,
                r1 INT NOT NULL DEFAULT 0,
                r2 INT NOT NULL DEFAULT 0,
                r3 INT NOT NULL DEFAULT 0,
                r4 INT NOT NULL DEFAULT 0,
                r5 INT NOT NULL DEFAULT 0,
                r6 INT NOT NULL DEFAULT 0,
                r7 INT NOT NULL DEFAULT 0,
                r8 INT NOT NULL DEFAULT 0,
                r9 INT NOT NULL DEFAULT 0,
                r10 INT NOT NULL DEFAULT 0,
                r11 INT NOT NULL DEFAULT 0,
                r12 INT NOT NULL DEFAULT 0,
                escala_max INT NOT NULL DEFAULT 5,
                estrellas_ponderadas DECIMAL(6,2) NOT NULL DEFAULT 0,
                puntaje_total DECIMAL(6,2) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    } catch (e) {}

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(250) NOT NULL,
                matricula VARCHAR(100) UNIQUE NOT NULL,
                email VARCHAR(150) NULL,
                password VARCHAR(255) NOT NULL,
                rol ENUM('estudiante', 'profesor', 'admin') NOT NULL DEFAULT 'estudiante',
                carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería',
                semestre INT DEFAULT 1,
                nivel_asignado INT DEFAULT 1,
                profesor_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
    } catch (e) {}

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS configuracion_smtp (
                id INT PRIMARY KEY DEFAULT 1,
                smtp_host VARCHAR(150) NOT NULL DEFAULT 'smtp.gmail.com',
                smtp_port INT NOT NULL DEFAULT 587,
                smtp_user VARCHAR(150) NOT NULL DEFAULT '',
                smtp_pass VARCHAR(255) NOT NULL DEFAULT '',
                smtp_from VARCHAR(200) NULL,
                webhook_url TEXT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        try {
            const [wCols] = await pool.query("SHOW COLUMNS FROM configuracion_smtp LIKE 'webhook_url'");
            if (wCols.length === 0) {
                await pool.query("ALTER TABLE configuracion_smtp ADD COLUMN webhook_url TEXT NULL");
            }
        } catch (ew) {
            try { await pool.query("ALTER TABLE configuracion_smtp ADD COLUMN webhook_url TEXT NULL"); } catch (ew2) {}
        }
        // Si existen variables en .env y la tabla está vacía, sincronizarlas inicialmente
        const envUser = (process.env.SMTP_USER || '').trim();
        const envPass = (process.env.SMTP_PASS || '').trim();
        const envWebhook = (process.env.SMTP_WEBHOOK_URL || '').trim() || null;
        if ((envUser && envPass) || envWebhook) {
            const [cfgRows] = await pool.query('SELECT id FROM configuracion_smtp WHERE id = 1');
            if (cfgRows.length === 0) {
                const envHost = (process.env.SMTP_HOST || (envUser.toLowerCase().endsWith('@gmail.com') ? 'smtp.gmail.com' : 'smtp.office365.com')).trim();
                const envPort = parseInt(process.env.SMTP_PORT) || 587;
                const envFrom = (process.env.SMTP_FROM || '').trim() || null;
                await pool.query(
                    'INSERT INTO configuracion_smtp (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, webhook_url) VALUES (1, ?, ?, ?, ?, ?, ?)',
                    [envHost, envPort, envUser, envPass, envFrom, envWebhook]
                );
            }
        }
    } catch (e) {}

    // 1. Asegurar columnas email y telefono en usuarios
    try {
        const [uEmailCols] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'email'");
        if (uEmailCols.length === 0) {
            await pool.query("ALTER TABLE usuarios ADD COLUMN email VARCHAR(150) NULL");
        }
    } catch (e) {
        try { await pool.query("ALTER TABLE usuarios ADD COLUMN email VARCHAR(150) NULL"); } catch (e2) {}
    }

    try {
        const [uTelCols] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'telefono'");
        if (uTelCols.length === 0) {
            await pool.query("ALTER TABLE usuarios ADD COLUMN telefono VARCHAR(30) NULL");
            console.log('[OK] Columna telefono agregada a usuarios');
        }
    } catch (e) {
        try { await pool.query("ALTER TABLE usuarios ADD COLUMN telefono VARCHAR(30) NULL"); } catch (e2) {}
    }

    // 2. Asegurar columnas email, telefono y carrera en profesores
    try {
        const [pEmailCols] = await pool.query("SHOW COLUMNS FROM profesores LIKE 'email'");
        if (pEmailCols.length === 0) {
            await pool.query("ALTER TABLE profesores ADD COLUMN email VARCHAR(150) NULL");
        }
    } catch (e) {
        try { await pool.query("ALTER TABLE profesores ADD COLUMN email VARCHAR(150) NULL"); } catch (e2) {}
    }

    try {
        const [pTelCols] = await pool.query("SHOW COLUMNS FROM profesores LIKE 'telefono'");
        if (pTelCols.length === 0) {
            await pool.query("ALTER TABLE profesores ADD COLUMN telefono VARCHAR(30) NULL");
            console.log('[OK] Columna telefono agregada a profesores');
        }
    } catch (e) {
        try { await pool.query("ALTER TABLE profesores ADD COLUMN telefono VARCHAR(30) NULL"); } catch (e2) {}
    }

    try {
        const [pCols] = await pool.query("SHOW COLUMNS FROM profesores LIKE 'carrera'");
        if (pCols.length === 0) {
            await pool.query("ALTER TABLE profesores ADD COLUMN carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería'");
            console.log('[OK] Columna carrera agregada a profesores');
        }
    } catch (e) {}

    // 3. Asegurar columnas en carteles
    try {
        const [cPart] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'participantes'");
        if (cPart.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN participantes TEXT NULL");
        }
    } catch (e) {}

    try {
        const [cClave] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'clave'");
        if (cClave.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN clave VARCHAR(50) NULL");
        }
    } catch (e) {}

    try {
        const [uCols] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'usuario_id'");
        if (uCols.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN usuario_id INT NULL");
        }
    } catch (e) {}

    // 4. Asegurar claves y participantes en carteles existentes (solo si les falta clave o participantes)
    try {
        const [existentes] = await pool.query("SELECT id, nombre_equipo, clave, participantes FROM carteles WHERE clave IS NULL OR clave = '' OR participantes IS NULL OR participantes = ''");
        for (const c of existentes) {
            const nuevaClave = c.clave || generarClaveAleatoria();
            const nuevosPart = (c.participantes || c.nombre_equipo || '').toUpperCase();
            await pool.query("UPDATE carteles SET clave = ?, participantes = ? WHERE id = ?", [nuevaClave, nuevosPart, c.id]);
        }
    } catch (e) {}

    // 5. Asegurar las 12 columnas de la Rúbrica (r1 a r12), escala_max, estrellas_ponderadas y puntaje_total en evaluaciones
    try {
        const [evalCols] = await pool.query("SHOW COLUMNS FROM evaluaciones");
        const nombresCols = new Set(evalCols.map(c => c.Field));

        for (let i = 1; i <= 12; i++) {
            const col = `r${i}`;
            if (!nombresCols.has(col)) {
                await pool.query(`ALTER TABLE evaluaciones ADD COLUMN ${col} INT NOT NULL DEFAULT 0`);
            }
        }

        if (!nombresCols.has('escala_max')) {
            await pool.query("ALTER TABLE evaluaciones ADD COLUMN escala_max INT NOT NULL DEFAULT 5");
        }
        if (!nombresCols.has('estrellas_ponderadas')) {
            await pool.query("ALTER TABLE evaluaciones ADD COLUMN estrellas_ponderadas DECIMAL(6,2) NOT NULL DEFAULT 0");
        }

        const colPuntaje = evalCols.find(c => c.Field === 'puntaje_total');
        if (!colPuntaje) {
            await pool.query("ALTER TABLE evaluaciones ADD COLUMN puntaje_total DECIMAL(6,2) NOT NULL DEFAULT 0");
        } else if ((colPuntaje.Extra && colPuntaje.Extra.toUpperCase().includes('GENERATED')) || !String(colPuntaje.Type).toLowerCase().includes('decimal')) {
            try {
                await pool.query("ALTER TABLE evaluaciones DROP COLUMN puntaje_total");
                await pool.query("ALTER TABLE evaluaciones ADD COLUMN puntaje_total DECIMAL(6,2) NOT NULL DEFAULT 0");
            } catch (eDrop) {
                try {
                    await pool.query("ALTER TABLE evaluaciones MODIFY COLUMN puntaje_total DECIMAL(6,2) NOT NULL DEFAULT 0");
                } catch (eMod) {}
            }
        }
    } catch (e) {}

    // 6. Sincronizar profesores existentes en la tabla usuarios si aún no están
    try {
        const [todosProfes] = await pool.query("SELECT * FROM profesores");
        for (const p of todosProfes) {
            const mat = 'prof_' + p.id;
            const telVal = p.telefono || p.email || null;
            const [uExist] = await pool.query("SELECT id FROM usuarios WHERE profesor_id = ? OR matricula = ?", [p.id, mat]);
            if (uExist.length === 0) {
                await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, telefono, email, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), mat, telVal, p.email || null, p.password || '123456', p.carrera || 'Ingeniería', p.nivel_asignado || 1, p.id]
                );
            }
        }
    } catch (e) {}

    // 7. ADMIN PREDETERMINADO TEMPORAL (Usuario: admin / Contraseña: admin123)
    try {
        const adminUserDefault = 'admin';
        const adminPassDefault = 'admin123';

        const [admExist] = await pool.query("SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)", [adminUserDefault]);
        if (admExist.length === 0) {
            await pool.query(
                "INSERT INTO usuarios (nombre, matricula, telefono, email, password, rol, carrera, nivel_asignado) VALUES ('ADMINISTRADOR PREDETERMINADO', ?, NULL, 'admin@uvmnet.edu', ?, 'admin', 'General', 1)",
                [adminUserDefault, adminPassDefault]
            );
            console.log(`[OK] Administrador predeterminado creado -> Usuario: ${adminUserDefault} | Contraseña: ${adminPassDefault}`);
        } else {
            await pool.query(
                "UPDATE usuarios SET password = ?, rol = 'admin' WHERE id = ?",
                [adminPassDefault, admExist[0].id]
            );
            console.log(`[OK] Administrador predeterminado activo -> Usuario: ${adminUserDefault} | Contraseña: ${adminPassDefault}`);
        }
    } catch (e) {
        console.warn('Error al asegurar admin predeterminado:', e.message || e.code);
    }

    esquemaVerificado = true;
    console.log('[OK] Esquema, columna telefono (SMS directo) y administrador predeterminado verificados correctamente.');
}

conectarBD();

// Middleware que garantiza que las columnas estén creadas antes de procesar peticiones API
app.use('/api', async (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Server-Boot-Id', SERVER_BOOT_ID);
    if (!esquemaVerificado && pool) {
        try {
            await asegurarEsquemaYColumnas();
        } catch (e) {}
    }
    next();
});

// --- ENDPOINTS AUTENTICACIÓN Y GESTIÓN DE USUARIOS ---

// Registro general de usuarios (Alumnos con número de celular / teléfono, registro instantáneo)
app.post('/api/registro', async (req, res) => {
    try {
        const { nombre, matricula, telefono, celular, email, password, carrera, semestre } = req.body;
        
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre completo, matrícula/usuario y contraseña son obligatorios." });
        }

        // Requerimiento: todas las letras se hacen mayúsculas (ej. gabriel guerrero -> GABRIEL GUERRERO)
        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
        const telVal = normalizarTelefono(telefono || celular || email || '') || null;
        const pass = password.trim();
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;

        // Verificar si la matrícula o usuario ya existe
        const [existente] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);
        if (existente.length > 0) {
            return res.status(400).json({ error: "Esa matrícula o usuario ya se encuentra registrado." });
        }

        const [result] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, telefono, email, password, rol, carrera, semestre) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, telVal, telVal, pass, 'estudiante', carreraVal, semVal]
        );

        const infoSms = generarDatosSmsCuenta({
            telefono: telVal,
            nombre: nombreMayus,
            matricula: mat,
            password: pass,
            rol: 'estudiante',
            carrera: carreraVal,
            nivel_asignado: 1,
            baseUrl: obtenerUrlBase(req)
        });

        res.json({
            mensaje: `¡${nombreMayus} registrado con éxito!`,
            datos_sms: infoSms.datos_cuenta,
            usuario: {
                id: result.insertId,
                nombre: nombreMayus,
                matricula: mat,
                telefono: telVal,
                email: telVal,
                rol: 'estudiante',
                carrera: carreraVal,
                semestre: semVal
            }
        });
    } catch (err) {
        res.status(400).json({ error: err.message || err.code || "Error de base de datos" });
    }
});

// Login general (Exclusivo para Alumnos y Administradores)
app.post('/api/login', async (req, res) => {
    try {
        const idf = (req.body.usuario || req.body.identificador || req.body.matricula || '').trim();
        const pass = (req.body.password || '').trim();

        if (!idf || !pass) {
            return res.status(400).json({ error: "Ingresa tu usuario/matrícula y contraseña." });
        }

        // 0. Acceso garantizado para el Administrador Predeterminado (admin / admin123 o admin / admin)
        const adminPassEnv = (process.env.ADMIN_PASSWORD || '').trim();
        if (idf.toLowerCase() === 'admin' && (pass === 'admin123' || pass === 'admin' || (adminPassEnv && pass === adminPassEnv))) {
            try {
                const [admRows] = await pool.query('SELECT id, nombre, matricula, telefono, email, rol, carrera, semestre, nivel_asignado FROM usuarios WHERE LOWER(TRIM(matricula)) = "admin"');
                if (admRows.length > 0) {
                    return res.json({ mensaje: "Acceso correcto", usuario: { ...admRows[0], rol: 'admin' } });
                }
            } catch (e) {}

            return res.json({
                mensaje: "Acceso concedido como Administrador Predeterminado",
                usuario: {
                    id: 1,
                    nombre: 'ADMINISTRADOR PREDETERMINADO',
                    matricula: 'admin',
                    telefono: null,
                    email: 'admin@uvmnet.edu',
                    rol: 'admin',
                    carrera: 'General',
                    nivel_asignado: 1
                }
            });
        }

        // 1. Buscar en tabla usuarios (por matrícula, nombre, teléfono o correo)
        const idfTel = normalizarTelefono(idf) || idf;
        const [rows] = await pool.query(
            'SELECT id, nombre, matricula, telefono, email, password, rol, carrera, semestre, nivel_asignado, profesor_id FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?) OR TRIM(telefono) = ? OR LOWER(TRIM(email)) = LOWER(?))',
            [idf, idf, idfTel, idf]
        );

        if (rows.length > 0 && rows[0].password === pass) {
            const u = rows[0];
            if (u.rol === 'profesor') {
                return res.status(403).json({
                    error: "Este inicio de sesión general es exclusivo para Alumnos y Administradores. Si eres Maestro / Juez Evaluador, ingresa mediante tu enlace exclusivo (/jueces).",
                    es_profesor: true
                });
            }
            delete u.password;
            return res.json({ mensaje: "Acceso correcto", usuario: u });
        }

        // 2.b Si no coincide, verificar si es admin en tabla legacy administradores (si existe)
        try {
            const [admins] = await pool.query('SELECT * FROM administradores WHERE usuario = ? AND password = ?', [idf, pass]);
            if (admins.length > 0) {
                return res.json({
                    mensaje: "Acceso concedido como Administrador",
                    usuario: {
                        id: admins[0].id || 1,
                        nombre: admins[0].nombre || 'ADMINISTRADOR GENERAL',
                        matricula: admins[0].usuario,
                        rol: 'admin',
                        carrera: 'General'
                    }
                });
            }
        } catch (e) {
            // Tabla legacy administradores no existe, continuar
        }

        // 3. Si es un profesor intentando entrar por el login general, indicarle que use el enlace exclusivo /jueces
        const [profes] = await pool.query(
            'SELECT id FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(?) OR TRIM(telefono) = ? OR LOWER(TRIM(email)) = LOWER(?) OR id = ?) AND password = ?',
            [idf, idfTel, idf, isNaN(idf) ? -1 : parseInt(idf), pass]
        );

        if (profes.length > 0) {
            return res.status(403).json({
                error: "Este inicio de sesión general es exclusivo para Alumnos y Administradores. Si eres Maestro / Juez Evaluador, ingresa mediante tu enlace exclusivo (/jueces).",
                es_profesor: true
            });
        }

        return res.status(401).json({ error: "Matrícula/Usuario o contraseña incorrectos." });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Obtener carteles del alumno (para su dashboard personal)
app.get('/api/estudiantes/:id/carteles', async (req, res) => {
    try {
        const usuarioId = req.params.id;
        const [uRows] = await pool.query('SELECT id, nombre FROM usuarios WHERE id = ?', [usuarioId]);
        const nombreU = uRows.length > 0 ? uRows[0].nombre : '';

        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.carrera, c.semestre, c.nivel, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                ROUND(AVG(e.puntaje_total), 2) as promedio_final,
                ROUND(AVG(COALESCE(NULLIF(e.estrellas_ponderadas, 0), e.puntaje_total / 20.0)), 2) as promedio_estrellas,
                (SELECT nombre FROM profesores p WHERE p.id = c.profesor_asesor_id) as asesor_nombre
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            WHERE c.usuario_id = ? OR (c.participantes IS NOT NULL AND UPPER(c.participantes) LIKE ?)
            GROUP BY c.id
            ORDER BY c.id DESC
        `;
        const [rows] = await pool.query(query, [usuarioId, `%${nombreU}%`]);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Listar todos los usuarios para el Admin (Alumnos, Profesores y Admins) incluyendo carteles asignados a cada profesor
app.get('/api/admin/usuarios', async (req, res) => {
    try {
        // Asegurar que cualquier usuario con rol 'profesor' tenga su registro sincronizado en la tabla profesores
        const [usuariosProfeSinId] = await pool.query("SELECT id, nombre, telefono, email, carrera, nivel_asignado, password FROM usuarios WHERE rol = 'profesor' AND profesor_id IS NULL");
        for (const u of usuariosProfeSinId) {
            const telU = u.telefono || u.email || null;
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)',
                [u.nombre, telU, telU, u.carrera || 'Ingeniería', u.nivel_asignado || 1, u.password || '123456']
            );
            await pool.query('UPDATE usuarios SET profesor_id = ? WHERE id = ?', [pIns.insertId, u.id]);
        }

        const [rows] = await pool.query(`
            SELECT id, nombre, matricula, COALESCE(NULLIF(telefono, ''), email) as telefono, email, rol, carrera, semestre, nivel_asignado, profesor_id, created_at
            FROM usuarios
            ORDER BY 
                CASE rol WHEN 'admin' THEN 1 WHEN 'profesor' THEN 2 ELSE 3 END,
                nombre ASC
        `);

        const [asignacionesRows] = await pool.query(`
            SELECT 
                a.id as asignacion_id,
                a.cartel_id,
                a.profesor_id,
                c.titulo_cartel,
                c.clave,
                c.nombre_equipo,
                c.participantes,
                c.carrera as cartel_carrera,
                c.semestre as cartel_semestre,
                c.nivel as cartel_nivel,
                c.archivo_url,
                CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END as ya_evaluo,
                e.puntaje_total,
                ROUND(COALESCE(NULLIF(e.estrellas_ponderadas, 0), e.puntaje_total / 20.0), 2) as estrellas_otorgadas
            FROM asignaciones a
            JOIN carteles c ON a.cartel_id = c.id
            LEFT JOIN evaluaciones e ON (e.cartel_id = a.cartel_id AND e.profesor_id = a.profesor_id)
            ORDER BY a.id ASC
        `);

        const mapaPorProfesor = {};
        asignacionesRows.forEach(a => {
            if (!mapaPorProfesor[a.profesor_id]) mapaPorProfesor[a.profesor_id] = [];
            mapaPorProfesor[a.profesor_id].push(a);
        });

        const resultado = rows.map(u => ({
            ...u,
            telefono: u.telefono || '',
            carteles_asignados: u.profesor_id ? (mapaPorProfesor[u.profesor_id] || []) : []
        }));

        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Función auxiliar para generar un identificador de usuario único para profesores/usuarios
async function generarMatriculaUnica(nombre, rol = 'profesor', matriculaBase = '') {
    const limpio = (nombre || '')
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    const prefijo = rol === 'profesor' ? 'prof_' : (rol === 'admin' ? 'admin_' : 'uvm_');
    let base = (matriculaBase || '').trim().toLowerCase().replace(/\s+/g, '_');

    if (!base || (rol !== 'admin' && base === 'admin')) {
        if (limpio.length >= 2) {
            base = `${prefijo}${limpio[0]}_${limpio[1]}`;
        } else if (limpio.length === 1) {
            base = `${prefijo}${limpio[0]}`;
        } else {
            base = `${prefijo}${Math.floor(100 + Math.random() * 900)}`;
        }
    }

    let candidato = base;
    for (let intento = 0; intento < 15; intento++) {
        const [rows] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [candidato]);
        if (rows.length === 0) {
            return candidato;
        }
        candidato = `${base}_${Math.floor(100 + Math.random() * 900)}`;
    }
    return `${base}_${Date.now().toString().slice(-4)}`;
}

// Admin da de alta a un usuario manualmente (eligiendo si es estudiante o profesor) y genera su SMS directo al instante
app.post('/api/admin/usuarios', async (req, res) => {
    try {
        const { nombre, matricula, telefono, celular, email, password, rol, carrera, semestre, nivel_asignado } = req.body;
        if (!nombre || !password) {
            return res.status(400).json({ error: "Nombre y contraseña son obligatorios." });
        }

        const nombreMayus = convertirMayusculas(nombre);
        const telVal = normalizarTelefono(telefono || celular || email || '') || null;
        const rolVal = (rol === 'profesor' || rol === 'admin') ? rol : 'estudiante';
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;
        const nivelVal = parseInt(nivel_asignado) || 1;

        let mat = (matricula || '').trim();
        // Si el navegador autocompletó "admin" por error al crear un profesor/estudiante o viene vacío, generamos uno limpio
        if (!mat || (rolVal !== 'admin' && mat.toLowerCase() === 'admin')) {
            mat = await generarMatriculaUnica(nombreMayus, rolVal, '');
        }

        // Buscar si ya existe por matrícula, o si es profesor y ya existe con el mismo nombre o teléfono
        let [existente] = await pool.query('SELECT * FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);

        if (existente.length === 0 && rolVal === 'profesor' && telVal) {
            const [porTel] = await pool.query(
                'SELECT * FROM usuarios WHERE (TRIM(telefono) = ? OR TRIM(email) = ?) AND LOWER(TRIM(nombre)) = LOWER(?)',
                [telVal, telVal, nombreMayus]
            );
            if (porTel.length > 0) existente = porTel;
        }

        if (existente.length > 0) {
            const uPrevio = existente[0];
            const mismoNombre = (uPrevio.nombre || '').trim().toUpperCase() === nombreMayus;
            const prevTel = normalizarTelefono(uPrevio.telefono || uPrevio.email || '');
            const mismoTel = Boolean(telVal && prevTel === telVal);

            // Verificar si era un registro huérfano (se eliminó de profesores pero quedó en usuarios)
            let esHuerfano = false;
            if (uPrevio.profesor_id) {
                const [pCheck] = await pool.query('SELECT id FROM profesores WHERE id = ?', [uPrevio.profesor_id]);
                if (pCheck.length === 0) esHuerfano = true;
            }

            if (mismoNombre || mismoTel || esHuerfano) {
                let profId = uPrevio.profesor_id;
                if (rolVal === 'profesor') {
                    if (profId && !esHuerfano) {
                        await pool.query(
                            'UPDATE profesores SET nombre = ?, telefono = ?, email = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                            [nombreMayus, telVal, telVal, carreraVal, nivelVal, password, profId]
                        );
                    } else {
                        const [pIns] = await pool.query(
                            'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)',
                            [nombreMayus, telVal, telVal, carreraVal, nivelVal, password]
                        );
                        profId = pIns.insertId;
                    }
                }

                const matFinal = (rolVal !== 'admin' && (uPrevio.matricula || '').trim().toLowerCase() === 'admin')
                    ? await generarMatriculaUnica(nombreMayus, rolVal, '')
                    : uPrevio.matricula;

                await pool.query(
                    'UPDATE usuarios SET nombre = ?, matricula = ?, telefono = ?, email = ?, password = ?, rol = ?, carrera = ?, semestre = ?, nivel_asignado = ?, profesor_id = ? WHERE id = ?',
                    [nombreMayus, matFinal, telVal, telVal, password, rolVal, carreraVal, semVal, nivelVal, profId, uPrevio.id]
                );

                const infoSms = generarDatosSmsCuenta({
                    telefono: telVal,
                    nombre: nombreMayus,
                    matricula: matFinal,
                    password,
                    rol: rolVal,
                    carrera: carreraVal,
                    nivel_asignado: nivelVal,
                    baseUrl: obtenerUrlBase(req)
                });

                return res.json({
                    mensaje: `Usuario ${nombreMayus} registrado/actualizado como ${rolVal} exitosamente con usuario "${matFinal}".`,
                    listo_sms: infoSms.listo_sms,
                    enlace_acceso: infoSms.enlace_acceso,
                    datos_cuenta: infoSms.datos_cuenta,
                    usuario: { id: uPrevio.id, nombre: nombreMayus, matricula: matFinal, telefono: telVal, email: telVal, rol: rolVal, carrera: carreraVal, nivel_asignado: nivelVal, profesor_id: profId }
                });
            }

            // Si es un profesor o administrador NUEVO (persona distinta) y sólo coincidió el identificador de usuario, generamos uno único automáticamente
            if (rolVal === 'profesor' || rolVal === 'admin') {
                mat = await generarMatriculaUnica(nombreMayus, rolVal, mat);
            } else {
                return res.status(400).json({ error: `La matrícula "${mat}" ya está registrada por otro estudiante (${uPrevio.nombre}).` });
            }
        }

        let profId = null;
        if (rolVal === 'profesor') {
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)',
                [nombreMayus, telVal, telVal, carreraVal, nivelVal, password]
            );
            profId = pIns.insertId;
        }

        const [uIns] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, telefono, email, password, rol, carrera, semestre, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, telVal, telVal, password, rolVal, carreraVal, semVal, nivelVal, profId]
        );

        const infoSms = generarDatosSmsCuenta({
            telefono: telVal,
            nombre: nombreMayus,
            matricula: mat,
            password,
            rol: rolVal,
            carrera: carreraVal,
            nivel_asignado: nivelVal,
            baseUrl: obtenerUrlBase(req)
        });

        res.json({
            mensaje: `Usuario ${nombreMayus} registrado como ${rolVal} exitosamente con usuario "${mat}".`,
            listo_sms: infoSms.listo_sms,
            enlace_acceso: infoSms.enlace_acceso,
            datos_cuenta: infoSms.datos_cuenta,
            usuario: { id: uIns.insertId, nombre: nombreMayus, matricula: mat, telefono: telVal, email: telVal, rol: rolVal, carrera: carreraVal, nivel_asignado: nivelVal, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin genera / envía por SMS directo el usuario, contraseña y enlace directo al dashboard de un profesor o usuario
async function manejarEnvioSmsUsuario(req, res) {
    try {
        const { id } = req.params;
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Usuario no encontrado." });
        }
        const u = rows[0];
        const rawInput = (req.body && (req.body.telefono || req.body.celular || req.body.email))
            ? (req.body.telefono || req.body.celular || req.body.email)
            : (u.telefono || u.email || '');
        const telDestino = normalizarTelefono(rawInput);

        if (!telDestino) {
            return res.status(400).json({ error: "Este usuario aún no tiene un número de celular registrado. Ingresa su número para enviarle el SMS directo." });
        }

        if (telDestino !== u.telefono) {
            await pool.query('UPDATE usuarios SET telefono = ?, email = ? WHERE id = ?', [telDestino, telDestino, u.id]);
            if (u.profesor_id) {
                await pool.query('UPDATE profesores SET telefono = ?, email = ? WHERE id = ?', [telDestino, telDestino, u.profesor_id]);
            }
        }

        const infoSms = generarDatosSmsCuenta({
            telefono: telDestino,
            nombre: u.nombre,
            matricula: u.matricula,
            password: u.password,
            rol: u.rol,
            carrera: u.carrera,
            nivel_asignado: u.nivel_asignado,
            baseUrl: obtenerUrlBase(req)
        });

        res.json({
            mensaje: `SMS directo listo para enviar al número ${telDestino} con el usuario (${u.matricula}), contraseña y enlace directo.`,
            listo_sms: true,
            enlace_acceso: infoSms.enlace_acceso,
            sms_url: infoSms.sms_url,
            whatsapp_url: infoSms.whatsapp_url,
            datos_cuenta: infoSms.datos_cuenta
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
}

app.post('/api/admin/usuarios/:id/enviar-sms', manejarEnvioSmsUsuario);
app.post('/api/admin/usuarios/:id/reenviar-correo', manejarEnvioSmsUsuario);

// Admin cambia el rol de un usuario (Promover a Profesor / Asignar como Estudiante / Promover a Administrador)
app.put('/api/admin/usuarios/:id/rol', async (req, res) => {
    try {
        const { id } = req.params;
        const { rol, carrera, nivel_asignado, password, telefono, celular, email } = req.body;

        const [userRows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (userRows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRows[0];

        const rolesValidos = ['estudiante', 'profesor', 'admin'];
        const nuevoRol = rolesValidos.includes(rol) ? rol : 'estudiante';
        const nuevaCarrera = (carrera && carrera.trim()) ? carrera.trim() : (nuevoRol === 'admin' ? 'General' : (user.carrera || 'Ingeniería'));
        const nuevoNivel = parseInt(nivel_asignado) || user.nivel_asignado || 1;
        const passActualizada = (password && password.trim()) ? password.trim() : user.password;
        const rawTel = telefono !== undefined ? telefono : (celular !== undefined ? celular : email);
        const telActualizado = rawTel !== undefined ? (normalizarTelefono(rawTel) || null) : (user.telefono || user.email || null);

        // Protección: Evitar degradar al único administrador del sistema
        if (user.rol === 'admin' && nuevoRol !== 'admin') {
            const [[{ totalAdmins }]] = await pool.query("SELECT COUNT(*) as totalAdmins FROM usuarios WHERE rol = 'admin'");
            if (totalAdmins <= 1) {
                return res.status(400).json({ error: "No es posible quitar el rol de Administrador porque es el único administrador registrado en el sistema." });
            }
        }

        let profId = user.profesor_id;

        if (nuevoRol === 'profesor') {
            if (!profId) {
                const [pIns] = await pool.query(
                    'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)',
                    [user.nombre, telActualizado, telActualizado, nuevaCarrera, nuevoNivel, passActualizada || '123456']
                );
                profId = pIns.insertId;
            } else {
                await pool.query(
                    'UPDATE profesores SET telefono = ?, email = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                    [telActualizado, telActualizado, nuevaCarrera, nuevoNivel, passActualizada, profId]
                );
            }
        } else if (profId && passActualizada !== user.password) {
            await pool.query('UPDATE profesores SET password = ? WHERE id = ?', [passActualizada, profId]);
        }

        await pool.query(
            'UPDATE usuarios SET rol = ?, telefono = ?, email = ?, carrera = ?, nivel_asignado = ?, profesor_id = ?, password = ? WHERE id = ?',
            [nuevoRol, telActualizado, telActualizado, nuevaCarrera, nuevoNivel, profId, passActualizada, id]
        );

        const infoSms = generarDatosSmsCuenta({
            telefono: telActualizado,
            nombre: user.nombre,
            matricula: user.matricula,
            password: passActualizada,
            rol: nuevoRol,
            carrera: nuevaCarrera,
            nivel_asignado: nuevoNivel,
            baseUrl: obtenerUrlBase(req)
        });

        const rolTexto = nuevoRol === 'admin' ? 'ADMINISTRADOR' : (nuevoRol === 'profesor' ? 'PROFESOR JUEZ' : 'ESTUDIANTE');

        res.json({
            mensaje: `¡Usuario ${user.nombre} ahora tiene el rol de ${rolTexto}!`,
            listo_sms: infoSms.listo_sms,
            enlace_acceso: infoSms.enlace_acceso,
            datos_cuenta: infoSms.datos_cuenta,
            usuario: { ...user, telefono: telActualizado, email: telActualizado, rol: nuevoRol, carrera: nuevaCarrera, nivel_asignado: nuevoNivel, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin edita datos de un usuario
app.put('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, matricula, telefono, celular, email, carrera, semestre, nivel_asignado, password, rol } = req.body;

        const [userRows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (userRows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRows[0];

        const rolesValidos = ['estudiante', 'profesor', 'admin'];
        const rolFinal = (rol && rolesValidos.includes(rol)) ? rol : user.rol;

        if (user.rol === 'admin' && rolFinal !== 'admin') {
            const [[{ totalAdmins }]] = await pool.query("SELECT COUNT(*) as totalAdmins FROM usuarios WHERE rol = 'admin'");
            if (totalAdmins <= 1) {
                return res.status(400).json({ error: "No es posible remover el rol de Administrador al único administrador registrado." });
            }
        }

        const nombreMayus = nombre ? convertirMayusculas(nombre) : user.nombre;
        const mat = matricula ? matricula.trim() : user.matricula;
        const rawTel = telefono !== undefined ? telefono : (celular !== undefined ? celular : email);
        const telVal = rawTel !== undefined ? (normalizarTelefono(rawTel) || null) : (user.telefono || user.email || null);
        const car = carrera || user.carrera;
        const sem = semestre !== undefined ? parseInt(semestre) : user.semestre;
        const niv = nivel_asignado !== undefined ? parseInt(nivel_asignado) : user.nivel_asignado;
        const pass = (password && password.trim()) ? password.trim() : user.password;

        await pool.query(
            'UPDATE usuarios SET nombre = ?, matricula = ?, telefono = ?, email = ?, carrera = ?, semestre = ?, nivel_asignado = ?, password = ?, rol = ? WHERE id = ?',
            [nombreMayus, mat, telVal, telVal, car, sem, niv, pass, rolFinal, id]
        );

        if (user.profesor_id) {
            await pool.query(
                'UPDATE profesores SET nombre = ?, telefono = ?, email = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                [nombreMayus, telVal, telVal, car, niv, pass, user.profesor_id]
            );
        }

        res.json({ mensaje: "Usuario actualizado correctamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin elimina un usuario
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [u] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (u.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        // Protección: No permitir eliminar al único administrador
        if (u[0].rol === 'admin') {
            const [[{ totalAdmins }]] = await pool.query("SELECT COUNT(*) as totalAdmins FROM usuarios WHERE rol = 'admin'");
            if (totalAdmins <= 1) {
                return res.status(400).json({ error: "No es posible eliminar al único Administrador del sistema." });
            }
        }

        // Si tiene profesor_id, limpiar sus relaciones y eliminar de profesores también
        if (u[0].profesor_id) {
            await pool.query('DELETE FROM asignaciones WHERE profesor_id = ?', [u[0].profesor_id]);
            await pool.query('DELETE FROM evaluaciones WHERE profesor_id = ?', [u[0].profesor_id]);
            await pool.query('UPDATE carteles SET profesor_asesor_id = NULL WHERE profesor_asesor_id = ?', [u[0].profesor_id]);
            await pool.query('DELETE FROM profesores WHERE id = ?', [u[0].profesor_id]);
        }

        await pool.query('DELETE FROM usuarios WHERE id = ?', [id]);
        res.json({ mensaje: "Usuario eliminado exitosamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- ENDPOINTS ADMINISTRADOR (AUTENTICACIÓN Y METRICAS) ---

app.post('/api/admin/login', async (req, res) => {
    try {
        const idf = (req.body.usuario || '').trim();
        const pass = (req.body.password || '').trim();

        if (!idf || !pass) {
            return res.status(400).json({ error: "Por favor ingresa usuario y contraseña de administrador." });
        }

        // 1. Buscar en la tabla principal usuarios con rol 'admin'
        const [rows] = await pool.query(
            'SELECT id, nombre, matricula, rol, carrera, semestre, nivel_asignado FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?)) AND password = ? AND rol = "admin"',
            [idf, idf, pass]
        );

        if (rows.length > 0) {
            return res.json({ mensaje: "Acceso concedido", usuario: rows[0] });
        }

        // 2. Soporte fallback para tabla legacy administradores (si existe)
        try {
            const [admins] = await pool.query('SELECT * FROM administradores WHERE usuario = ? AND password = ?', [idf, pass]);
            if (admins.length > 0) {
                return res.json({
                    mensaje: "Acceso concedido",
                    usuario: {
                        id: admins[0].id || 1,
                        nombre: admins[0].nombre || 'ADMINISTRADOR GENERAL',
                        matricula: admins[0].usuario,
                        rol: 'admin',
                        carrera: 'General'
                    }
                });
            }
        } catch (e) {
            // Tabla legacy no existe o no tiene datos
        }

        return res.status(401).json({ error: "Credenciales incorrectas o este usuario no cuenta con privilegios de Administrador." });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Cambiar el nivel de evaluación de un profesor
app.put('/api/profesores/:id/nivel', async (req, res) => {
    try {
        const { id } = req.params;
        const { nivel_asignado } = req.body;
        await pool.query('UPDATE profesores SET nivel_asignado = ? WHERE id = ?', [parseInt(nivel_asignado), id]);
        res.json({ mensaje: "Nivel de profesor actualizado correctamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Cambiar el área / carrera de un profesor
app.put('/api/profesores/:id/carrera', async (req, res) => {
    try {
        const { id } = req.params;
        const { carrera } = req.body;
        await pool.query('UPDATE profesores SET carrera = ? WHERE id = ?', [carrera, id]);
        res.json({ mensaje: "Área de profesor actualizada correctamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Eliminar a un profesor y limpiar sus relaciones
app.delete('/api/profesores/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;

        await connection.execute('DELETE FROM asignaciones WHERE profesor_id = ?', [id]);
        await connection.execute('DELETE FROM evaluaciones WHERE profesor_id = ?', [id]);
        await connection.execute('UPDATE carteles SET profesor_asesor_id = NULL WHERE profesor_asesor_id = ?', [id]);
        await connection.execute('DELETE FROM usuarios WHERE profesor_id = ?', [id]);
        await connection.execute('DELETE FROM profesores WHERE id = ?', [id]);

        await connection.commit();
        res.json({ mensaje: "Profesor eliminado exitosamente" });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Métricas para el Dashboard
app.get('/api/admin/metricas', async (req, res) => {
    try {
        const [[carteles]] = await pool.query('SELECT COUNT(*) as total FROM carteles');
        const [[profesores]] = await pool.query('SELECT COUNT(*) as total FROM profesores');
        const [[evaluaciones]] = await pool.query('SELECT COUNT(*) as total FROM evaluaciones');
        const [[estudiantes]] = await pool.query("SELECT COUNT(*) as total FROM usuarios WHERE rol = 'estudiante'");
        const [[administradores]] = await pool.query("SELECT COUNT(*) as total FROM usuarios WHERE rol = 'admin'");
        res.json({
            carteles: carteles.total,
            profesores: profesores.total,
            estudiantes: estudiantes.total,
            administradores: administradores.total,
            evaluaciones: evaluaciones.total
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- ENDPOINTS PROFESORES Y JUECES ---

app.get('/api/profesores', async (req, res) => {
    try {
        // Sincronizar cualquier usuario con rol 'profesor' que aún no tenga registro en la tabla profesores
        const [usuariosProfeSinId] = await pool.query("SELECT id, nombre, telefono, email, carrera, nivel_asignado, password FROM usuarios WHERE rol = 'profesor' AND profesor_id IS NULL");
        for (const u of usuariosProfeSinId) {
            const telU = u.telefono || u.email || null;
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)',
                [u.nombre, telU, telU, u.carrera || 'Ingeniería', u.nivel_asignado || 1, u.password || '123456']
            );
            await pool.query('UPDATE usuarios SET profesor_id = ? WHERE id = ?', [pIns.insertId, u.id]);
        }

        const [rows] = await pool.query('SELECT id, nombre, carrera, nivel_asignado FROM profesores ORDER BY nombre ASC');
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/profesores', async (req, res) => {
    try {
        const { nombre, matricula, telefono, celular, email, carrera, nivel_asignado, password } = req.body;
        if (!nombre || !password) {
            return res.status(400).json({ error: "El nombre y la contraseña son obligatorios" });
        }
        const nombreMayus = convertirMayusculas(nombre.trim());
        const telVal = normalizarTelefono(telefono || celular || email || '') || null;
        const areaCarrera = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const nivelAleatorio = Math.floor(Math.random() * 3) + 1;
        const nivel = (nivel_asignado !== undefined && nivel_asignado !== null && nivel_asignado !== '') 
            ? parseInt(nivel_asignado) 
            : nivelAleatorio;

        const query = 'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)';
        const [result] = await pool.query(query, [nombreMayus, telVal, telVal, areaCarrera, nivel, password]);
        const profId = result.insertId;

        const matFinal = (matricula && matricula.trim()) ? matricula.trim() : `prof_${profId}`;
        const [uIns] = await pool.query(
            "INSERT INTO usuarios (nombre, matricula, telefono, email, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, 'profesor', ?, ?, ?)",
            [nombreMayus, matFinal, telVal, telVal, password, areaCarrera, nivel, profId]
        );

        const infoSms = generarDatosSmsCuenta({
            telefono: telVal,
            nombre: nombreMayus,
            matricula: matFinal,
            password,
            rol: 'profesor',
            carrera: areaCarrera,
            nivel_asignado: nivel,
            baseUrl: obtenerUrlBase(req)
        });

        res.json({
            id: profId,
            usuario_id: uIns.insertId,
            matricula: matFinal,
            listo_sms: infoSms.listo_sms,
            enlace_acceso: infoSms.enlace_acceso,
            datos_cuenta: infoSms.datos_cuenta,
            mensaje: `Profesor ${nombreMayus} registrado con éxito en ${areaCarrera} (Nivel ${nivel}).`
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Asignar niveles aleatorios y balanceados a todos los profesores
app.post('/api/admin/profesores/randomizar-niveles', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [profesores] = await connection.execute('SELECT id, carrera FROM profesores');
        
        if (profesores.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: "No hay profesores registrados para asignar niveles." });
        }

        const porArea = {};
        profesores.forEach(p => {
            const area = p.carrera || 'General';
            if (!porArea[area]) porArea[area] = [];
            porArea[area].push(p.id);
        });

        for (const area in porArea) {
            const ids = porArea[area];
            for (let i = ids.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [ids[i], ids[j]] = [ids[j], ids[i]];
            }
            for (let i = 0; i < ids.length; i++) {
                const nuevoNivel = (i % 3) + 1;
                await connection.execute('UPDATE profesores SET nivel_asignado = ? WHERE id = ?', [nuevoNivel, ids[i]]);
                await connection.execute('UPDATE usuarios SET nivel_asignado = ? WHERE profesor_id = ?', [nuevoNivel, ids[i]]);
            }
        }

        await connection.commit();
        res.json({ mensaje: `¡Se asignaron y balancearon aleatoriamente los niveles para ${profesores.length} profesor(es) por área!` });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Login exclusivo para Maestros y Jueces Evaluadores (mediante enlace /jueces)
app.post('/api/login/profesor', async (req, res) => {
    try {
        const idf = (req.body.usuario || req.body.identificador || req.body.matricula || req.body.nombre || req.body.profesor_id || '').toString().trim();
        const pass = (req.body.password || '').toString().trim();

        if (!idf || !pass) {
            return res.status(400).json({ error: "Por favor ingresa tu usuario/celular y contraseña de profesor." });
        }

        const idfTel = normalizarTelefono(idf) || idf;

        // 1. Buscar en tabla usuarios (por matrícula, teléfono, correo o nombre)
        const [uRows] = await pool.query(
            'SELECT id, nombre, matricula, telefono, email, password, rol, carrera, semestre, nivel_asignado, profesor_id FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR TRIM(telefono) = ? OR LOWER(TRIM(email)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?))',
            [idf, idfTel, idf, idf]
        );

        if (uRows.length > 0 && uRows[0].password === pass) {
            const u = uRows[0];
            if (u.rol !== 'profesor') {
                return res.status(403).json({
                    error: "Este acceso es exclusivo para Maestros y Jueces Evaluadores. Si eres Alumno o Administrador, ingresa desde el acceso general."
                });
            }

            if (!u.profesor_id) {
                const telU = u.telefono || u.email || null;
                const [pIns] = await pool.query(
                    'INSERT INTO profesores (nombre, telefono, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?, ?)',
                    [u.nombre, telU, telU, u.carrera || 'Ingeniería', u.nivel_asignado || 1, u.password || '123456']
                );
                u.profesor_id = pIns.insertId;
                await pool.query('UPDATE usuarios SET profesor_id = ? WHERE id = ?', [u.profesor_id, u.id]);
            }

            delete u.password;
            return res.json({
                mensaje: "Acceso concedido como Profesor Juez",
                usuario: u,
                ...u
            });
        }

        // 2. Buscar en tabla profesores directamente (por nombre, teléfono, correo o ID)
        const idParam = isNaN(idf) ? -1 : parseInt(idf);
        const [profes] = await pool.query(
            'SELECT id, nombre, telefono, email, carrera, nivel_asignado, password FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(?) OR TRIM(telefono) = ? OR LOWER(TRIM(email)) = LOWER(?) OR id = ?) AND password = ?',
            [idf, idfTel, idf, idParam, pass]
        );

        if (profes.length > 0) {
            const p = profes[0];
            const telP = p.telefono || p.email || null;
            const [uCheck] = await pool.query('SELECT id, matricula, telefono, email, rol FROM usuarios WHERE profesor_id = ?', [p.id]);
            let uId = uCheck.length > 0 ? uCheck[0].id : null;
            let mat = uCheck.length > 0 ? uCheck[0].matricula : `prof_${p.id}`;
            if (!uId) {
                const [ins] = await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, telefono, email, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), mat, telP, telP, pass, p.carrera, p.nivel_asignado, p.id]
                );
                uId = ins.insertId;
            }
            const usuarioObj = {
                id: uId,
                nombre: p.nombre.toUpperCase(),
                matricula: mat,
                telefono: telP,
                email: telP,
                rol: 'profesor',
                carrera: p.carrera,
                nivel_asignado: p.nivel_asignado,
                profesor_id: p.id
            };
            return res.json({
                mensaje: "Acceso concedido como Profesor Juez",
                usuario: usuarioObj,
                ...usuarioObj
            });
        }

        return res.status(401).json({ error: "Usuario/Celular o contraseña de profesor incorrectos." });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- CARTELES, CLAVES Y EVALUACIONES ---

// Obtener lista completa de carteles para administración (incluyendo profesores asignados)
app.get('/api/admin/carteles', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.carrera, c.semestre, c.nivel, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                (SELECT nombre FROM profesores p WHERE p.id = c.profesor_asesor_id) as asesor_nombre
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            GROUP BY c.id
            ORDER BY c.id DESC
        `;
        const [rows] = await pool.query(query);

        const [asignacionesRows] = await pool.query(`
            SELECT 
                a.id as asignacion_id,
                a.cartel_id,
                a.profesor_id,
                p.nombre as profesor_nombre,
                p.carrera as profesor_carrera,
                p.nivel_asignado as profesor_nivel,
                CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END as ya_evaluo
            FROM asignaciones a
            JOIN profesores p ON a.profesor_id = p.id
            LEFT JOIN evaluaciones e ON (e.cartel_id = a.cartel_id AND e.profesor_id = a.profesor_id)
            ORDER BY a.id ASC
        `);

        const mapaAsignados = {};
        asignacionesRows.forEach(a => {
            if (!mapaAsignados[a.cartel_id]) mapaAsignados[a.cartel_id] = [];
            mapaAsignados[a.cartel_id].push(a);
        });

        const resultado = rows.map(c => ({
            ...c,
            asignados: mapaAsignados[c.id] || []
        }));

        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Obtener todas las asignaciones de carteles a profesores (vista admin)
app.get('/api/admin/asignaciones', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                a.id,
                a.cartel_id,
                a.profesor_id,
                c.titulo_cartel,
                c.clave,
                c.nombre_equipo,
                c.participantes,
                c.archivo_url,
                c.carrera as cartel_carrera,
                c.semestre as cartel_semestre,
                c.nivel as cartel_nivel,
                p.nombre as profesor_nombre,
                p.carrera as profesor_carrera,
                p.nivel_asignado as profesor_nivel,
                CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END as ya_evaluo,
                e.puntaje_total,
                ROUND(COALESCE(NULLIF(e.estrellas_ponderadas, 0), e.puntaje_total / 20.0), 2) as estrellas_otorgadas
            FROM asignaciones a
            JOIN carteles c ON a.cartel_id = c.id
            JOIN profesores p ON a.profesor_id = p.id
            LEFT JOIN evaluaciones e ON (e.cartel_id = a.cartel_id AND e.profesor_id = a.profesor_id)
            ORDER BY a.id DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Asignar manualmente un cartel a un profesor juez (por ID de cartel o por código/clave manual, máximo 3 jueces por cartel)
app.post('/api/admin/asignaciones', async (req, res) => {
    try {
        let cartelId = parseInt(req.body.cartel_id);
        const claveCartel = (req.body.clave_cartel || req.body.clave || '').trim().toUpperCase();
        const profesorId = parseInt(req.body.profesor_id);

        if (!profesorId) {
            return res.status(400).json({ error: "Debes seleccionar un profesor juez." });
        }

        let cartelRow = null;
        if (claveCartel) {
            const [cPorClave] = await pool.query('SELECT id, titulo_cartel, clave, profesor_asesor_id FROM carteles WHERE LOWER(TRIM(clave)) = LOWER(?)', [claveCartel]);
            if (cPorClave.length === 0) {
                return res.status(404).json({ error: `No se encontró ningún cartel con el código/clave "${claveCartel}".` });
            }
            cartelRow = cPorClave[0];
            cartelId = cartelRow.id;
        } else if (cartelId) {
            const [cRows] = await pool.query('SELECT id, titulo_cartel, clave, profesor_asesor_id FROM carteles WHERE id = ?', [cartelId]);
            if (cRows.length === 0) {
                return res.status(404).json({ error: "El cartel seleccionado no existe." });
            }
            cartelRow = cRows[0];
        } else {
            return res.status(400).json({ error: "Debes seleccionar un cartel o ingresar su código/clave." });
        }

        const [pRows] = await pool.query('SELECT id, nombre FROM profesores WHERE id = ?', [profesorId]);
        if (pRows.length === 0) {
            return res.status(404).json({ error: "El profesor seleccionado no existe." });
        }

        const [existente] = await pool.query(
            'SELECT id FROM asignaciones WHERE cartel_id = ? AND profesor_id = ?',
            [cartelId, profesorId]
        );
        if (existente.length > 0) {
            return res.status(400).json({ error: `El cartel "${cartelRow.titulo_cartel}" [${cartelRow.clave}] ya está asignado al profesor ${pRows[0].nombre}.` });
        }

        // Validar máximo de 3 jueces por cartel (mínimo 2, máximo 3)
        const [[conteoActual]] = await pool.query(
            'SELECT COUNT(*) as total FROM asignaciones WHERE cartel_id = ?',
            [cartelId]
        );
        if (conteoActual.total >= 3) {
            return res.status(400).json({
                error: `El cartel "${cartelRow.titulo_cartel}" [${cartelRow.clave}] ya tiene el máximo de 3 jueces asignados (${conteoActual.total}/3). Si deseas asignar otro, primero quita uno de los actuales.`
            });
        }

        const [result] = await pool.query(
            'INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)',
            [cartelId, profesorId]
        );

        const nuevoTotal = conteoActual.total + 1;
        res.json({
            id: result.insertId,
            mensaje: `¡Cartel "${cartelRow.titulo_cartel}" [${cartelRow.clave}] asignado manualmente a ${pRows[0].nombre}! (Jueces asignados: ${nuevoTotal} — Mín. 2 / Máx. 3)`
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Eliminar una asignación manual o automática de un profesor a un cartel
app.delete('/api/admin/asignaciones/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM asignaciones WHERE id = ?', [id]);
        res.json({ mensaje: "Asignación removida correctamente." });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});



// Helper para verificar que una petición provenga de un Profesor / Juez autenticado
async function verificarAccesoProfesorJuez(connOrPool, usuarioId, profesorId) {
    const uid = parseInt(usuarioId);
    const pid = parseInt(profesorId);

    if (uid && !isNaN(uid)) {
        const [uRows] = await connOrPool.query(
            "SELECT id, rol, profesor_id FROM usuarios WHERE id = ? AND rol = 'profesor'",
            [uid]
        );
        if (uRows.length > 0) return true;
    }

    if (pid && !isNaN(pid)) {
        const [pRows] = await connOrPool.query(
            'SELECT id FROM profesores WHERE id = ?',
            [pid]
        );
        if (pRows.length > 0) return true;
    }

    return false;
}

// Obtener detalles de un cartel por su clave (exclusivo para profesores/jueces desde su dashboard)
app.get('/api/carteles/clave/:clave', async (req, res) => {
    try {
        const usuarioId = req.query.usuario_id;
        const profesorId = req.query.profesor_id;

        const autorizado = await verificarAccesoProfesorJuez(pool, usuarioId, profesorId);
        if (!autorizado) {
            return res.status(403).json({
                error: "Acceso denegado: Solo los profesores/jueces con sesión iniciada pueden consultar y evaluar carteles mediante clave."
            });
        }

        const clave = (req.params.clave || '').trim();
        if (!clave) return res.status(400).json({ error: "Por favor proporciona la clave del cartel." });

        const [carteles] = await pool.query(
            `SELECT c.*, 
                    (SELECT COUNT(*) FROM evaluaciones e WHERE e.cartel_id = c.id) as total_evaluaciones,
                    (SELECT nombre FROM profesores p WHERE p.id = c.profesor_asesor_id) as asesor_nombre
             FROM carteles c
             WHERE LOWER(TRIM(c.clave)) = LOWER(TRIM(?))`,
            [clave]
        );

        if (carteles.length === 0) {
            return res.status(404).json({ error: "No se encontró ningún cartel con esa clave de acceso." });
        }

        const cartel = carteles[0];

        // Obtener profesores asignados al cartel y quién ya evaluó vs quién está pendiente (para tomar su lugar)
        const [asignados] = await pool.query(
            `SELECT p.id, p.nombre, p.carrera,
                    CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END as ya_evaluo
             FROM asignaciones a
             JOIN profesores p ON a.profesor_id = p.id
             LEFT JOIN evaluaciones e ON (e.cartel_id = a.cartel_id AND e.profesor_id = a.profesor_id)
             WHERE a.cartel_id = ?`,
            [cartel.id]
        );

        res.json({
            cartel,
            asignados,
            puede_evaluar: cartel.total_evaluaciones < 3
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Eliminar un cartel individual y sus datos
app.delete('/api/carteles/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;

        const [[cartel]] = await connection.execute('SELECT archivo_url FROM carteles WHERE id = ?', [id]);
        if (!cartel) {
            await connection.rollback();
            return res.status(404).json({ error: "Cartel no encontrado" });
        }

        await connection.execute('DELETE FROM asignaciones WHERE cartel_id = ?', [id]);
        await connection.execute('DELETE FROM evaluaciones WHERE cartel_id = ?', [id]);
        await connection.execute('DELETE FROM carteles WHERE id = ?', [id]);

        await connection.commit();

        if (cartel.archivo_url) {
            const fileName = path.basename(cartel.archivo_url);
            const filePath = path.join(uploadsDir, fileName);
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { console.warn("No se pudo borrar archivo:", e.message); }
            }
        }

        res.json({ mensaje: "Cartel y evaluaciones eliminados correctamente" });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Eliminar todos los carteles antiguos (limpieza general)
app.delete('/api/admin/carteles/todos', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [carteles] = await connection.execute('SELECT archivo_url FROM carteles');

        await connection.execute('DELETE FROM asignaciones');
        await connection.execute('DELETE FROM evaluaciones');
        await connection.execute('DELETE FROM carteles');

        await connection.commit();

        for (const c of carteles) {
            if (c.archivo_url) {
                const fileName = path.basename(c.archivo_url);
                const filePath = path.join(uploadsDir, fileName);
                if (fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (e) {}
                }
            }
        }

        res.json({ mensaje: `Se eliminaron ${carteles.length} carteles y se limpiaron todas sus asignaciones y evaluaciones.` });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Asignar o cambiar manualmente el código/clave de un cartel (o generar uno aleatorio)
app.put('/api/admin/carteles/:id/clave', async (req, res) => {
    try {
        const { id } = req.params;
        const { clave, generar_automatico } = req.body || {};

        const [cRows] = await pool.query('SELECT id, titulo_cartel, clave FROM carteles WHERE id = ?', [id]);
        if (cRows.length === 0) {
            return res.status(404).json({ error: "Cartel no encontrado." });
        }

        let nuevaClave = '';
        if (generar_automatico) {
            nuevaClave = generarClaveAleatoria();
            let existe = true;
            while (existe) {
                const [dup] = await pool.query('SELECT id FROM carteles WHERE LOWER(TRIM(clave)) = LOWER(?) AND id != ?', [nuevaClave, id]);
                if (dup.length === 0) existe = false;
                else nuevaClave = generarClaveAleatoria();
            }
        } else {
            nuevaClave = (clave || '').trim().toUpperCase();
            if (!nuevaClave) {
                return res.status(400).json({ error: "Por favor escribe el código/clave que deseas asignar al cartel." });
            }
            const [dup] = await pool.query('SELECT id, titulo_cartel FROM carteles WHERE LOWER(TRIM(clave)) = LOWER(?) AND id != ?', [nuevaClave, id]);
            if (dup.length > 0) {
                return res.status(400).json({ error: `El código "${nuevaClave}" ya está asignado a otro cartel ("${dup[0].titulo_cartel}").` });
            }
        }

        await pool.query('UPDATE carteles SET clave = ? WHERE id = ?', [nuevaClave, id]);

        res.json({
            mensaje: `Código del cartel "${cRows[0].titulo_cartel}" actualizado exitosamente a: ${nuevaClave}`,
            clave: nuevaClave
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Registrar nuevo cartel con asignación automática o manual de clave y participantes (Nombres de alumnos en MAYÚSCULAS)
app.post('/api/carteles', upload.single('archivo_pdf'), async (req, res) => {
    try {
        const { nombre_equipo, participantes, carrera, semestre, titulo_cartel, profesor_asesor_id, usuario_id, clave_manual } = req.body;
        const archivo_url = req.file ? `/uploads/${req.file.filename}` : '';

        const sem = parseInt(semestre);
        let nivel = 1;
        if (sem >= 4 && sem <= 6) nivel = 2;
        if (sem >= 7) nivel = 3;

        const equipoCap = capitalizarNombre((nombre_equipo || '').trim());
        // Requerimiento: todas las letras de los alumnos se hacen mayúsculas (ej. gabriel guerrero -> GABRIEL GUERRERO)
        const participantesMayus = convertirMayusculas((participantes || '').trim());
        const listaParticipantes = participantesMayus.split(',').map(p => p.trim()).filter(Boolean);
        if (listaParticipantes.length === 0) {
            return res.status(400).json({ error: "Debes registrar al menos un integrante en el equipo." });
        }
        if (listaParticipantes.length > 5) {
            return res.status(400).json({ error: "El equipo puede tener un máximo de 5 integrantes." });
        }
        const tituloLimpio = (titulo_cartel || '').trim();
        const usrId = usuario_id ? parseInt(usuario_id) : null;

        // Soportar código/clave manual o generar clave única automáticamente en el servidor
        let claveGenerada = (clave_manual || '').trim().toUpperCase();
        if (claveGenerada) {
            const [dup] = await pool.query('SELECT id, titulo_cartel FROM carteles WHERE LOWER(TRIM(clave)) = LOWER(?)', [claveGenerada]);
            if (dup.length > 0) {
                return res.status(400).json({ error: `El código "${claveGenerada}" ya está en uso por otro cartel ("${dup[0].titulo_cartel}"). Ingresa otro o déjalo en blanco para generarlo automáticamente.` });
            }
        } else {
            claveGenerada = generarClaveAleatoria();
            let existeClave = true;
            while (existeClave) {
                const [existentes] = await pool.query('SELECT id FROM carteles WHERE clave = ?', [claveGenerada]);
                if (existentes.length === 0) {
                    existeClave = false;
                } else {
                    claveGenerada = generarClaveAleatoria();
                }
            }
        }

        const query = `INSERT INTO carteles (usuario_id, nombre_equipo, participantes, carrera, semestre, nivel, titulo_cartel, clave, archivo_url, profesor_asesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await pool.query(query, [usrId, equipoCap, participantesMayus, carrera, sem, nivel, tituloLimpio, claveGenerada, archivo_url, profesor_asesor_id || null]);

        res.json({ 
            id: result.insertId, 
            clave: claveGenerada,
            mensaje: `Cartel registrado con éxito en Nivel ${nivel}. Clave asignada: ${claveGenerada}` 
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Repartir carteles entre profesores jueces (mínimo 2 jueces y máximo 3 jueces por cartel)
async function ejecutarRepartoCarteles(req, res) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM asignaciones');

        const [carteles] = await connection.execute('SELECT id, titulo_cartel, nivel, carrera, profesor_asesor_id FROM carteles');
        const [profesores] = await connection.execute('SELECT id, nombre, nivel_asignado, carrera FROM profesores');

        if (carteles.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: "No hay carteles registrados para repartir." });
        }

        const cargaProfesores = {};
        profesores.forEach(p => cargaProfesores[p.id] = 0);

        for (const cartel of carteles) {
            const candidatosValidos = profesores.filter(p => 
                Number(p.nivel_asignado) === Number(cartel.nivel) &&
                p.carrera && cartel.carrera &&
                p.carrera.trim().toLowerCase() === cartel.carrera.trim().toLowerCase() &&
                p.id !== cartel.profesor_asesor_id
            );

            if (candidatosValidos.length < 2) {
                throw new Error(
                    `El cartel "${cartel.titulo_cartel}" (Área: ${cartel.carrera}, Nivel ${cartel.nivel}) requiere mínimo 2 profesores jueces (máximo 3) de su misma área y nivel. Disponibles actualmente: ${candidatosValidos.length}. Asigna o registra al menos 2 profesores de ${cartel.carrera} en Nivel ${cartel.nivel}.`
                );
            }

            candidatosValidos.sort((a, b) => cargaProfesores[a.id] - cargaProfesores[b.id]);
            // Asignar mínimo 2 y máximo 3 jueces
            const asignados = candidatosValidos.slice(0, 3);

            for (const profe of asignados) {
                await connection.execute('INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)', [cartel.id, profe.id]);
                cargaProfesores[profe.id]++;
            }
        }

        await connection.commit();
        res.json({ mensaje: "¡Carteles repartidos exitosamente entre los profesores jueces (mínimo 2 y máximo 3 jueces por cartel)!" });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
}

app.post('/api/admin/repartir-carteles', ejecutarRepartoCarteles);
app.post('/api/admin/cerrar-y-asignar', ejecutarRepartoCarteles);

app.get('/api/profesores/:profesor_id/carteles-asignados', async (req, res) => {
    try {
        const { profesor_id } = req.params;
        const query = `
            SELECT c.*, 
                   (SELECT COUNT(*) FROM evaluaciones e2 WHERE e2.cartel_id = c.id) as total_evaluaciones
            FROM asignaciones a
            JOIN carteles c ON a.cartel_id = c.id
            LEFT JOIN evaluaciones e ON (e.cartel_id = c.id AND e.profesor_id = a.profesor_id)
            WHERE a.profesor_id = ? AND e.id IS NULL
        `;
        const [rows] = await pool.query(query, [profesor_id]);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Evaluar por profesor asignado (Rúbrica Oficial de 12 Criterios Ponderados)
app.post('/api/evaluar', async (req, res) => {
    try {
        const { cartel_id, profesor_id } = req.body;
        const resultadoRubrica = calcularPuntajeRubrica(req.body);

        if (!resultadoRubrica.valido) {
            return res.status(400).json({ error: resultadoRubrica.error });
        }

        const [conteo] = await pool.query(`SELECT COUNT(*) as total FROM evaluaciones WHERE cartel_id = ?`, [cartel_id]);
        if (conteo[0].total >= 3) {
            return res.status(400).json({ error: "Este cartel ya cuenta con sus 3 evaluaciones completadas." });
        }

        const v = resultadoRubrica.valores;
        const query = `
            INSERT INTO evaluaciones (
                cartel_id, profesor_id,
                r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12,
                escala_max, estrellas_ponderadas, puntaje_total
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await pool.query(query, [
            cartel_id, profesor_id,
            v.r1, v.r2, v.r3, v.r4, v.r5, v.r6, v.r7, v.r8, v.r9, v.r10, v.r11, v.r12,
            resultadoRubrica.escala_max,
            resultadoRubrica.estrellas_ponderadas,
            resultadoRubrica.puntaje_total
        ]);

        res.json({
            mensaje: "Evaluación registrada con éxito",
            estrellas_ponderadas: resultadoRubrica.estrellas_ponderadas,
            puntaje_total: resultadoRubrica.puntaje_total
        });
    } catch (err) {
        res.status(400).json({ error: "Error o ya habías evaluado este cartel." });
    }
});

// Evaluar por Maestro Invitado mediante Clave (Exclusivo desde el Dashboard de Profesores/Jueces)
app.post('/api/evaluar-invitado', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { clave, nombre_maestro, suplir_profesor_id, usuario_id, profesor_id } = req.body;

        const autorizado = await verificarAccesoProfesorJuez(connection, usuario_id, profesor_id);
        if (!autorizado) {
            await connection.rollback();
            return res.status(403).json({
                error: "Acceso denegado: Solo los profesores/jueces con sesión activa pueden registrar evaluaciones de maestro invitado."
            });
        }

        if (!clave || !nombre_maestro || !nombre_maestro.trim()) {
            await connection.rollback();
            return res.status(400).json({ error: "La clave del cartel y el nombre del Maestro Invitado son requeridos." });
        }

        const resultadoRubrica = calcularPuntajeRubrica(req.body);
        if (!resultadoRubrica.valido) {
            await connection.rollback();
            return res.status(400).json({ error: resultadoRubrica.error });
        }

        // Buscar cartel por clave
        const [carteles] = await connection.execute(
            'SELECT id, nivel, carrera, titulo_cartel FROM carteles WHERE LOWER(TRIM(clave)) = LOWER(TRIM(?))',
            [clave.trim()]
        );
        if (carteles.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: "No se encontró ningún cartel con esa clave." });
        }
        const cartel = carteles[0];

        // Validar conteo de evaluaciones (< 3)
        const [[conteo]] = await connection.execute('SELECT COUNT(*) as total FROM evaluaciones WHERE cartel_id = ?', [cartel.id]);
        if (conteo.total >= 3) {
            await connection.rollback();
            return res.status(400).json({ error: "Este cartel ya cuenta con sus 3 evaluaciones completadas." });
        }

        // Nombre del maestro invitado con mayúscula en cada palabra
        const nombreFormateado = capitalizarNombre(nombre_maestro.trim());

        // Buscar o registrar al maestro invitado en la tabla de profesores
        let profesorId;
        const [existentes] = await connection.execute(
            'SELECT id FROM profesores WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
            [nombreFormateado]
        );
        if (existentes.length > 0) {
            profesorId = existentes[0].id;
        } else {
            const [nuevoProfe] = await connection.execute(
                'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)',
                [nombreFormateado, cartel.carrera || 'General', cartel.nivel || 1, 'invitado123']
            );
            profesorId = nuevoProfe.insertId;
        }

        // Verificar si este profesor ya evaluó este cartel
        const [yaEvaluado] = await connection.execute(
            'SELECT id FROM evaluaciones WHERE cartel_id = ? AND profesor_id = ?',
            [cartel.id, profesorId]
        );
        if (yaEvaluado.length > 0) {
            await connection.rollback();
            return res.status(400).json({ error: `El maestro ${nombreFormateado} ya registró una calificación previa para este cartel.` });
        }

        // Si se indicó a qué profesor ausente está supliendo:
        if (suplir_profesor_id) {
            // Reemplazar la asignación del profesor ausente por la del profesor invitado
            await connection.execute(
                'UPDATE asignaciones SET profesor_id = ? WHERE cartel_id = ? AND profesor_id = ?',
                [profesorId, cartel.id, parseInt(suplir_profesor_id)]
            );
        } else {
            // Verificar si ya tiene asignación, sino registrarla
            const [asigCheck] = await connection.execute(
                'SELECT id FROM asignaciones WHERE cartel_id = ? AND profesor_id = ?',
                [cartel.id, profesorId]
            );
            if (asigCheck.length === 0) {
                await connection.execute(
                    'INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)',
                    [cartel.id, profesorId]
                );
            }
        }

        // Guardar la evaluación con los 12 criterios ponderados
        const v = resultadoRubrica.valores;
        await connection.execute(
            `INSERT INTO evaluaciones (
                cartel_id, profesor_id,
                r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12,
                escala_max, estrellas_ponderadas, puntaje_total
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                cartel.id, profesorId,
                v.r1, v.r2, v.r3, v.r4, v.r5, v.r6, v.r7, v.r8, v.r9, v.r10, v.r11, v.r12,
                resultadoRubrica.escala_max,
                resultadoRubrica.estrellas_ponderadas,
                resultadoRubrica.puntaje_total
            ]
        );

        await connection.commit();
        res.json({ 
            mensaje: `¡Evaluación registrada exitosamente por ${nombreFormateado}!`,
            cartel_id: cartel.id,
            estrellas_ponderadas: resultadoRubrica.estrellas_ponderadas,
            puntaje_total: resultadoRubrica.puntaje_total
        });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Escala activa para visualización del Ranking y calificaciones (10 = sobre 10, 100 = sobre 100%)
let escalaRankingGlobal = 10;

app.get('/api/escala-ranking', (req, res) => {
    res.json({ escala: escalaRankingGlobal });
});

app.post('/api/admin/escala-ranking', (req, res) => {
    const nueva = parseInt(req.body && req.body.escala);
    escalaRankingGlobal = (nueva === 100) ? 100 : 10;
    res.json({
        mensaje: `Escala del Ranking actualizada a base ${escalaRankingGlobal}.`,
        escala: escalaRankingGlobal
    });
});

// Ranking general por niveles con participantes, clave y promedio de estrellas ponderadas
app.get('/api/dashboard/ranking', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.nivel, c.carrera, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                ROUND(AVG(e.puntaje_total), 2) as promedio_final,
                ROUND(AVG(COALESCE(NULLIF(e.estrellas_ponderadas, 0), e.puntaje_total / 20.0)), 2) as promedio_estrellas
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            GROUP BY c.id
            ORDER BY c.nivel ASC, promedio_final DESC
        `;
        const [rows] = await pool.query(query);
        res.setHeader('X-Escala-Ranking', String(escalaRankingGlobal));
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));