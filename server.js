const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

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

// Helper para obtener la configuración SMTP activa (primero desde la base de datos configurada en el Panel Admin y luego desde .env)
async function obtenerConfiguracionSmtp() {
    let dbCfg = null;
    if (pool) {
        try {
            const [rows] = await pool.query('SELECT * FROM configuracion_smtp WHERE id = 1 LIMIT 1');
            if (rows.length > 0 && rows[0].smtp_user && rows[0].smtp_pass) {
                dbCfg = rows[0];
            }
        } catch (e) {}
    }

    const rawUser = dbCfg ? dbCfg.smtp_user : (process.env.SMTP_USER || '');
    const rawPass = dbCfg ? dbCfg.smtp_pass : (process.env.SMTP_PASS || '');
    const rawHost = dbCfg ? dbCfg.smtp_host : (process.env.SMTP_HOST || '');
    const rawPort = dbCfg ? dbCfg.smtp_port : (process.env.SMTP_PORT || '');
    const rawFrom = dbCfg ? dbCfg.smtp_from : (process.env.SMTP_FROM || '');

    const smtpUser = (rawUser || '').trim();
    const smtpPass = (rawPass || '').trim().replace(/\s+/g, '');
    let smtpHost = (rawHost || 'smtp.gmail.com').trim();
    if (smtpUser.toLowerCase().endsWith('@gmail.com')) {
        smtpHost = 'smtp.gmail.com';
    }
    const smtpPort = parseInt(rawPort) || 587;
    const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;
    const smtpFrom = (rawFrom && rawFrom.trim()) ? rawFrom.trim() : `"Sistema de Carteles UVM" <${smtpUser}>`;

    return {
        smtpHost,
        smtpPort,
        smtpSecure,
        smtpUser,
        smtpPass,
        smtpFrom,
        configurado: Boolean(smtpUser && smtpPass),
        origen: dbCfg ? 'panel_admin' : ((smtpUser && smtpPass) ? 'env' : 'ninguno')
    };
}

// Helper para enviar correo automático con los datos de la cuenta y enlace al dashboard (Profesores / Usuarios)
async function enviarCorreoDatosCuenta({ email, nombre, matricula, password, rol, carrera, nivel_asignado, baseUrl }) {
    const urlServidor = (baseUrl || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const enlaceAcceso = rol === 'profesor'
        ? `${urlServidor}/jueces?usuario=${encodeURIComponent(matricula)}`
        : (rol === 'admin' ? `${urlServidor}/admin` : `${urlServidor}/`);

    if (!email || !email.trim()) {
        return { enviado: false, motivo: 'Sin correo electrónico proporcionado', enlace_acceso: enlaceAcceso };
    }

    const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFrom, configurado } = await obtenerConfiguracionSmtp();

    if (!configurado) {
        console.warn(`[CORREO] No se pudo enviar correo a ${email}: Configura el correo SMTP desde el Panel de Administrador.`);
        return { enviado: false, motivo: 'SMTP no configurado (configúralo desde el botón "Configurar Correo SMTP" en el Panel de Administrador)', enlace_acceso: enlaceAcceso };
    }

    try {
        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpSecure,
            requireTLS: smtpPort === 587,
            auth: {
                user: smtpUser,
                pass: smtpPass
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        const rolEtiqueta = rol === 'profesor'
            ? 'Profesor / Juez Evaluador'
            : (rol === 'admin' ? 'Administrador' : 'Estudiante (Alumno)');

        const textoBoton = rol === 'profesor'
            ? 'Ingresar a Mi Dashboard de Juez Evaluador'
            : 'Ingresar al Sistema de Carteles UVM';

        const htmlBody = `
            <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background-color: #b91c1c; color: #ffffff; padding: 20px 24px;">
                    <h2 style="margin: 0; font-size: 20px;">Sistema de Evaluación de Carteles - UVM</h2>
                    <p style="margin: 4px 0 0; font-size: 13px; color: #fecaca;">
                        ${rol === 'profesor' ? 'Invitación y Acceso Exclusivo para Maestros / Jueces' : 'Datos de acceso a tu cuenta'}
                    </p>
                </div>
                <div style="padding: 24px; color: #1e293b; background-color: #ffffff;">
                    <p style="margin-top: 0; font-size: 15px;">Hola, <strong>${nombre}</strong>:</p>
                    <p style="font-size: 14px; line-height: 1.5; color: #475569;">
                        ${rol === 'profesor'
                            ? 'El Administrador te ha dado de alta como <strong>Profesor / Juez Evaluador</strong> en el Sistema de Evaluación de Carteles UVM. A continuación, te compartimos tu usuario, contraseña y el enlace directo a tu dashboard:'
                            : 'Tu cuenta ha sido dada de alta en el Sistema de Evaluación de Carteles UVM. A continuación, te compartimos tus datos de ingreso:'}
                    </p>
                    <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0;">
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Nombre:</strong> ${nombre}</p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Usuario / ID de Acceso:</strong> <code style="background: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold; color: #991b1b; border: 1px solid #fecaca;">${matricula}</code></p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Correo registrado:</strong> ${email}</p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Contraseña:</strong> <code style="background: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold; color: #991b1b; border: 1px solid #fecaca;">${password}</code></p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Rol en el sistema:</strong> ${rolEtiqueta}</p>
                        <p style="margin: 6px 0; font-size: 14px;"><strong>Área / Carrera:</strong> ${carrera || 'General'}</p>
                        ${rol === 'profesor' ? `<p style="margin: 6px 0; font-size: 14px;"><strong>Nivel Asignado para Evaluar:</strong> Nivel ${nivel_asignado || 1}</p>` : ''}
                    </div>
                    <div style="text-align: center; margin: 26px 0;">
                        <a href="${enlaceAcceso}" style="display: inline-block; background-color: #b91c1c; color: #ffffff; text-decoration: none; font-weight: bold; font-size: 14px; padding: 13px 26px; border-radius: 8px;">
                            ${textoBoton}
                        </a>
                    </div>
                    <p style="font-size: 12px; color: #64748b; background-color: #f8fafc; padding: 10px 12px; border-radius: 6px; border: 1px solid #e2e8f0; word-break: break-all;">
                        <strong>Enlace directo de acceso:</strong><br>
                        <a href="${enlaceAcceso}" style="color: #b91c1c;">${enlaceAcceso}</a>
                    </p>
                    <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">
                        Puedes iniciar sesión utilizando tu <strong>Usuario (${matricula})</strong> o tu <strong>Correo Electrónico (${email})</strong> junto con tu contraseña.
                    </p>
                </div>
                <div style="background-color: #f8fafc; padding: 12px 24px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
                    UVM - Encuentro Académico • Sistema de Evaluación de Carteles
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: smtpFrom,
            to: email.trim(),
            subject: rol === 'profesor'
                ? 'Acceso Exclusivo de Juez Evaluador - Carteles UVM'
                : 'Datos de Ingreso - Sistema de Evaluación de Carteles UVM',
            html: htmlBody
        });

        console.log(`[CORREO] Credenciales y enlace (${enlaceAcceso}) enviados exitosamente a ${email}`);
        return { enviado: true, enlace_acceso: enlaceAcceso };
    } catch (err) {
        console.warn(`[CORREO] Error al enviar correo a ${email}:`, err.message);
        return { enviado: false, motivo: err.message, enlace_acceso: enlaceAcceso };
    }
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
                r1 INT NOT NULL,
                r2 INT NOT NULL,
                r3 INT NOT NULL,
                r4 INT NOT NULL,
                r5 INT DEFAULT 0,
                puntaje_total INT GENERATED ALWAYS AS (r1 + r2 + r3 + r4 + r5) STORED,
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
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // Si existen variables en .env y la tabla está vacía, sincronizarlas inicialmente
        const envUser = (process.env.SMTP_USER || '').trim();
        const envPass = (process.env.SMTP_PASS || '').trim();
        if (envUser && envPass) {
            const [cfgRows] = await pool.query('SELECT id FROM configuracion_smtp WHERE id = 1');
            if (cfgRows.length === 0) {
                const envHost = (process.env.SMTP_HOST || (envUser.toLowerCase().endsWith('@gmail.com') ? 'smtp.gmail.com' : 'smtp.office365.com')).trim();
                const envPort = parseInt(process.env.SMTP_PORT) || 587;
                const envFrom = (process.env.SMTP_FROM || '').trim() || null;
                await pool.query(
                    'INSERT INTO configuracion_smtp (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from) VALUES (1, ?, ?, ?, ?, ?)',
                    [envHost, envPort, envUser, envPass, envFrom]
                );
            }
        }
    } catch (e) {}

    // 1. Asegurar columna email en usuarios (ejecución directa e independiente para evitar error "Unknown column 'email'")
    try {
        const [uEmailCols] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'email'");
        if (uEmailCols.length === 0) {
            await pool.query("ALTER TABLE usuarios ADD COLUMN email VARCHAR(150) NULL");
            console.log('[OK] Columna email agregada a usuarios');
        }
    } catch (e) {
        try {
            await pool.query("ALTER TABLE usuarios ADD COLUMN email VARCHAR(150) NULL");
            console.log('[OK] Columna email agregada a usuarios (fallback)');
        } catch (e2) {}
    }

    // 2. Asegurar columna email y carrera en profesores
    try {
        const [pEmailCols] = await pool.query("SHOW COLUMNS FROM profesores LIKE 'email'");
        if (pEmailCols.length === 0) {
            await pool.query("ALTER TABLE profesores ADD COLUMN email VARCHAR(150) NULL");
            console.log('[OK] Columna email agregada a profesores');
        }
    } catch (e) {
        try {
            await pool.query("ALTER TABLE profesores ADD COLUMN email VARCHAR(150) NULL");
        } catch (e2) {}
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

    // 5. Permitir r5 con default 0 en evaluaciones (solo si aún no tiene default)
    try {
        const [r5Cols] = await pool.query("SHOW COLUMNS FROM evaluaciones LIKE 'r5'");
        if (r5Cols.length > 0 && r5Cols[0].Default === null) {
            await pool.query("ALTER TABLE evaluaciones MODIFY COLUMN r5 INT(11) DEFAULT 0");
        }
    } catch (e) {}

    // 6. Sincronizar profesores existentes en la tabla usuarios si aún no están
    try {
        const [todosProfes] = await pool.query("SELECT * FROM profesores");
        for (const p of todosProfes) {
            const mat = 'prof_' + p.id;
            const [uExist] = await pool.query("SELECT id FROM usuarios WHERE profesor_id = ? OR matricula = ?", [p.id, mat]);
            if (uExist.length === 0) {
                await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, email, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), mat, p.email || null, p.password || '123456', p.carrera || 'Ingeniería', p.nivel_asignado || 1, p.id]
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
                "INSERT INTO usuarios (nombre, matricula, email, password, rol, carrera, nivel_asignado) VALUES ('ADMINISTRADOR PREDETERMINADO', ?, 'admin@uvmnet.edu', ?, 'admin', 'General', 1)",
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
    console.log('[OK] Esquema, columna email y administrador predeterminado verificados correctamente.');
}

conectarBD();

// Middleware que garantiza que las columnas (como email) estén creadas antes de procesar peticiones API
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

// Registro general de usuarios (Envía correo automático con los datos de ingreso)
app.post('/api/registro', async (req, res) => {
    try {
        const { nombre, matricula, email, password, carrera, semestre } = req.body;
        
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre completo, matrícula/usuario y contraseña son obligatorios." });
        }

        // Requerimiento: todas las letras se hacen mayúsculas (ej. gabriel guerrero -> GABRIEL GUERRERO)
        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
        const emailVal = email ? email.trim().toLowerCase() : null;
        const pass = password.trim();
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;

        // Verificar si la matrícula o usuario ya existe
        const [existente] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);
        if (existente.length > 0) {
            return res.status(400).json({ error: "Esa matrícula o usuario ya se encuentra registrado." });
        }

        const [result] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, email, password, rol, carrera, semestre) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, emailVal, pass, 'estudiante', carreraVal, semVal]
        );

        let infoCorreo = { enviado: false };
        if (emailVal) {
            infoCorreo = await enviarCorreoDatosCuenta({
                email: emailVal,
                nombre: nombreMayus,
                matricula: mat,
                password: pass,
                rol: 'estudiante',
                carrera: carreraVal,
                nivel_asignado: 1,
                baseUrl: obtenerUrlBase(req)
            });
        }

        const msgExtraCorreo = infoCorreo.enviado
            ? ` Se han enviado tus datos de ingreso al correo ${emailVal}.`
            : '';

        res.json({
            mensaje: `¡${nombreMayus} registrado con éxito!${msgExtraCorreo}`,
            correo_enviado: infoCorreo.enviado,
            usuario: {
                id: result.insertId,
                nombre: nombreMayus,
                matricula: mat,
                email: emailVal,
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
                const [admRows] = await pool.query('SELECT id, nombre, matricula, email, rol, carrera, semestre, nivel_asignado FROM usuarios WHERE LOWER(TRIM(matricula)) = "admin"');
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
                    email: 'admin@uvmnet.edu',
                    rol: 'admin',
                    carrera: 'General',
                    nivel_asignado: 1
                }
            });
        }

        // 1. Buscar en tabla usuarios (por matrícula, nombre o correo)
        const [rows] = await pool.query(
            'SELECT id, nombre, matricula, email, password, rol, carrera, semestre, nivel_asignado, profesor_id FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?) OR LOWER(TRIM(email)) = LOWER(?))',
            [idf, idf, idf]
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
            'SELECT id FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(?) OR LOWER(TRIM(email)) = LOWER(?) OR id = ?) AND password = ?',
            [idf, idf, isNaN(idf) ? -1 : parseInt(idf), pass]
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
                ROUND(AVG(e.puntaje_total) / 4.0, 2) as promedio_estrellas,
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
        const [usuariosProfeSinId] = await pool.query("SELECT id, nombre, email, carrera, nivel_asignado, password FROM usuarios WHERE rol = 'profesor' AND profesor_id IS NULL");
        for (const u of usuariosProfeSinId) {
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?)',
                [u.nombre, u.email || null, u.carrera || 'Ingeniería', u.nivel_asignado || 1, u.password || '123456']
            );
            await pool.query('UPDATE usuarios SET profesor_id = ? WHERE id = ?', [pIns.insertId, u.id]);
        }

        const [rows] = await pool.query(`
            SELECT id, nombre, matricula, email, rol, carrera, semestre, nivel_asignado, profesor_id, created_at
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
                ROUND(e.puntaje_total / 4.0, 2) as estrellas_otorgadas
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
            carteles_asignados: u.profesor_id ? (mapaPorProfesor[u.profesor_id] || []) : []
        }));

        res.json(resultado);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin da de alta a un usuario manualmente (eligiendo si es estudiante o profesor)
app.post('/api/admin/usuarios', async (req, res) => {
    try {
        const { nombre, matricula, email, password, rol, carrera, semestre, nivel_asignado } = req.body;
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre, usuario/matrícula y contraseña son obligatorios." });
        }

        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
        const emailVal = email ? email.trim().toLowerCase() : null;
        const rolVal = (rol === 'profesor' || rol === 'admin') ? rol : 'estudiante';
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;
        const nivelVal = parseInt(nivel_asignado) || 1;

        const [existente] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);
        if (existente.length > 0) {
            return res.status(400).json({ error: "Esa matrícula o usuario ya existe." });
        }

        let profId = null;
        if (rolVal === 'profesor') {
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?)',
                [nombreMayus, emailVal, carreraVal, nivelVal, password]
            );
            profId = pIns.insertId;
        }

        const [uIns] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, email, password, rol, carrera, semestre, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, emailVal, password, rolVal, carreraVal, semVal, nivelVal, profId]
        );

        let infoCorreo = { enviado: false };
        if (emailVal) {
            infoCorreo = await enviarCorreoDatosCuenta({
                email: emailVal,
                nombre: nombreMayus,
                matricula: mat,
                password,
                rol: rolVal,
                carrera: carreraVal,
                nivel_asignado: nivelVal,
                baseUrl: obtenerUrlBase(req)
            });
        }

        const msgExtraCorreo = infoCorreo.enviado
            ? ` Se enviaron automáticamente el usuario, contraseña y enlace de acceso a ${emailVal}.`
            : (emailVal ? ` (Aviso de correo: ${infoCorreo.motivo || 'revisa tu configuración SMTP en .env'})` : '');

        res.json({
            mensaje: `Usuario ${nombreMayus} registrado como ${rolVal} exitosamente.${msgExtraCorreo}`,
            correo_enviado: infoCorreo.enviado,
            enlace_acceso: infoCorreo.enlace_acceso,
            usuario: { id: uIns.insertId, nombre: nombreMayus, matricula: mat, email: emailVal, rol: rolVal, carrera: carreraVal, nivel_asignado: nivelVal, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin reenvía por correo el usuario, contraseña y enlace directo al dashboard de un profesor o usuario
app.post('/api/admin/usuarios/:id/reenviar-correo', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Usuario no encontrado." });
        }
        const u = rows[0];
        const emailDestino = (req.body && req.body.email ? req.body.email.trim().toLowerCase() : (u.email || '')).trim();
        if (!emailDestino) {
            return res.status(400).json({ error: "Este usuario aún no tiene un correo electrónico registrado. Edita su perfil para agregar su correo." });
        }

        if (emailDestino !== u.email) {
            await pool.query('UPDATE usuarios SET email = ? WHERE id = ?', [emailDestino, u.id]);
            if (u.profesor_id) {
                await pool.query('UPDATE profesores SET email = ? WHERE id = ?', [emailDestino, u.profesor_id]);
            }
        }

        const infoCorreo = await enviarCorreoDatosCuenta({
            email: emailDestino,
            nombre: u.nombre,
            matricula: u.matricula,
            password: u.password,
            rol: u.rol,
            carrera: u.carrera,
            nivel_asignado: u.nivel_asignado,
            baseUrl: obtenerUrlBase(req)
        });

        if (!infoCorreo.enviado) {
            return res.status(400).json({
                error: `No se pudo enviar el correo a ${emailDestino}: ${infoCorreo.motivo || 'Revisa la configuración de correo SMTP en el Panel de Administrador'}`,
                enlace_acceso: infoCorreo.enlace_acceso
            });
        }

        res.json({
            mensaje: `¡Correo enviado exitosamente a ${emailDestino} con su usuario (${u.matricula}), contraseña y enlace directo a su dashboard!`,
            correo_enviado: true,
            enlace_acceso: infoCorreo.enlace_acceso
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Obtener configuración actual de correo SMTP para el Panel de Administrador
app.get('/api/admin/smtp', async (req, res) => {
    try {
        const cfg = await obtenerConfiguracionSmtp();
        res.json({
            configurado: cfg.configurado,
            smtp_host: cfg.smtpHost,
            smtp_port: cfg.smtpPort,
            smtp_user: cfg.smtpUser,
            smtp_from: cfg.smtpFrom,
            tiene_password: Boolean(cfg.smtpPass),
            origen: cfg.origen
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Guardar configuración de correo SMTP desde el Panel de Administrador (se almacena en la BD para funcionar en el servidor sin .env)
app.post('/api/admin/smtp', async (req, res) => {
    try {
        const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
        const userLimpio = (smtp_user || '').trim();
        if (!userLimpio) {
            return res.status(400).json({ error: "El correo remitente (SMTP User) es obligatorio." });
        }

        let passLimpia = (smtp_pass || '').trim().replace(/\s+/g, '');
        if (!passLimpia) {
            const actual = await obtenerConfiguracionSmtp();
            if (actual.smtpPass) {
                passLimpia = actual.smtpPass;
            } else {
                return res.status(400).json({ error: "Ingresa la contraseña o contraseña de aplicación de 16 letras." });
            }
        }

        let hostLimpio = (smtp_host || 'smtp.gmail.com').trim();
        if (userLimpio.toLowerCase().endsWith('@gmail.com')) {
            hostLimpio = 'smtp.gmail.com';
        }
        const portLimpio = parseInt(smtp_port) || 587;
        const fromLimpio = (smtp_from || '').trim() || `"Sistema de Carteles UVM" <${userLimpio}>`;

        await pool.query(
            `INSERT INTO configuracion_smtp (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from)
             VALUES (1, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                smtp_host = VALUES(smtp_host),
                smtp_port = VALUES(smtp_port),
                smtp_user = VALUES(smtp_user),
                smtp_pass = VALUES(smtp_pass),
                smtp_from = VALUES(smtp_from)`,
            [hostLimpio, portLimpio, userLimpio, passLimpia, fromLimpio]
        );

        res.json({
            mensaje: "¡Configuración de correo SMTP guardada en la base de datos! Ahora el servidor ya puede enviar correos.",
            configurado: true,
            smtp_host: hostLimpio,
            smtp_port: portLimpio,
            smtp_user: userLimpio,
            smtp_from: fromLimpio
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Probar envío de correo SMTP desde el Panel de Administrador
app.post('/api/admin/smtp/probar', async (req, res) => {
    try {
        const cfg = await obtenerConfiguracionSmtp();
        if (!cfg.configurado) {
            return res.status(400).json({ error: "Primero guarda el correo remitente y la contraseña de aplicación." });
        }

        const destino = ((req.body && req.body.email_destino) ? req.body.email_destino.trim() : cfg.smtpUser);
        const info = await enviarCorreoDatosCuenta({
            email: destino,
            nombre: 'PRUEBA DE CORREO ADMIN',
            matricula: 'admin',
            password: '(Tu contraseña actual)',
            rol: 'profesor',
            carrera: 'Ingeniería',
            nivel_asignado: 1,
            baseUrl: obtenerUrlBase(req)
        });

        if (!info.enviado) {
            return res.status(400).json({ error: `Falló la prueba de envío: ${info.motivo}` });
        }

        res.json({ mensaje: `¡Correo de prueba enviado con éxito a ${destino}!` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin cambia el rol de un usuario (Promover a Profesor / Asignar como Estudiante / Promover a Administrador)
app.put('/api/admin/usuarios/:id/rol', async (req, res) => {
    try {
        const { id } = req.params;
        const { rol, carrera, nivel_asignado, password, email } = req.body;

        const [userRows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (userRows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRows[0];

        const rolesValidos = ['estudiante', 'profesor', 'admin'];
        const nuevoRol = rolesValidos.includes(rol) ? rol : 'estudiante';
        const nuevaCarrera = (carrera && carrera.trim()) ? carrera.trim() : (nuevoRol === 'admin' ? 'General' : (user.carrera || 'Ingeniería'));
        const nuevoNivel = parseInt(nivel_asignado) || user.nivel_asignado || 1;
        const passActualizada = (password && password.trim()) ? password.trim() : user.password;
        const emailActualizado = email !== undefined ? (email.trim() ? email.trim().toLowerCase() : null) : user.email;

        // Protección: Evitar degradar al único administrador del sistema
        if (user.rol === 'admin' && nuevoRol !== 'admin') {
            const [[{ totalAdmins }]] = await pool.query("SELECT COUNT(*) as totalAdmins FROM usuarios WHERE rol = 'admin'");
            if (totalAdmins <= 1) {
                return res.status(400).json({ error: "No es posible quitar el rol de Administrador porque es el único administrador registrado en el sistema." });
            }
        }

        let profId = user.profesor_id;

        if (nuevoRol === 'profesor') {
            // Si no estaba en la tabla profesores, registrarlo
            if (!profId) {
                const [pIns] = await pool.query(
                    'INSERT INTO profesores (nombre, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?)',
                    [user.nombre, emailActualizado, nuevaCarrera, nuevoNivel, passActualizada || '123456']
                );
                profId = pIns.insertId;
            } else {
                // Actualizar sus datos en profesores
                await pool.query(
                    'UPDATE profesores SET email = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                    [emailActualizado, nuevaCarrera, nuevoNivel, passActualizada, profId]
                );
            }
        } else if (profId && passActualizada !== user.password) {
            // Si se cambió la contraseña y tiene cuenta de profesor asociada
            await pool.query('UPDATE profesores SET password = ? WHERE id = ?', [passActualizada, profId]);
        }

        await pool.query(
            'UPDATE usuarios SET rol = ?, email = ?, carrera = ?, nivel_asignado = ?, profesor_id = ?, password = ? WHERE id = ?',
            [nuevoRol, emailActualizado, nuevaCarrera, nuevoNivel, profId, passActualizada, id]
        );

        let infoCorreo = { enviado: false };
        if (nuevoRol === 'profesor' && emailActualizado) {
            infoCorreo = await enviarCorreoDatosCuenta({
                email: emailActualizado,
                nombre: user.nombre,
                matricula: user.matricula,
                password: passActualizada,
                rol: 'profesor',
                carrera: nuevaCarrera,
                nivel_asignado: nuevoNivel,
                baseUrl: obtenerUrlBase(req)
            });
        }

        const rolTexto = nuevoRol === 'admin' ? 'ADMINISTRADOR' : (nuevoRol === 'profesor' ? 'PROFESOR JUEZ' : 'ESTUDIANTE');
        const msgCorreo = infoCorreo.enviado
            ? ` Se enviaron los datos de ingreso y el enlace exclusivo a ${emailActualizado}.`
            : '';

        res.json({
            mensaje: `¡Usuario ${user.nombre} ahora tiene el rol de ${rolTexto}!${msgCorreo}`,
            correo_enviado: infoCorreo.enviado,
            enlace_acceso: infoCorreo.enlace_acceso,
            usuario: { ...user, email: emailActualizado, rol: nuevoRol, carrera: nuevaCarrera, nivel_asignado: nuevoNivel, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin edita datos de un usuario
app.put('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, matricula, email, carrera, semestre, nivel_asignado, password, rol } = req.body;

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
        const emailVal = email !== undefined ? (email.trim() ? email.trim().toLowerCase() : null) : user.email;
        const car = carrera || user.carrera;
        const sem = semestre !== undefined ? parseInt(semestre) : user.semestre;
        const niv = nivel_asignado !== undefined ? parseInt(nivel_asignado) : user.nivel_asignado;
        const pass = (password && password.trim()) ? password.trim() : user.password;

        await pool.query(
            'UPDATE usuarios SET nombre = ?, matricula = ?, email = ?, carrera = ?, semestre = ?, nivel_asignado = ?, password = ?, rol = ? WHERE id = ?',
            [nombreMayus, mat, emailVal, car, sem, niv, pass, rolFinal, id]
        );

        if (user.profesor_id) {
            await pool.query(
                'UPDATE profesores SET nombre = ?, email = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                [nombreMayus, emailVal, car, niv, pass, user.profesor_id]
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

        // Si tiene profesor_id y tiene asignaciones o evaluaciones, no borrar directamente o limpiar
        if (u[0].profesor_id) {
            const [asigs] = await pool.query('SELECT id FROM asignaciones WHERE profesor_id = ?', [u[0].profesor_id]);
            const [evals] = await pool.query('SELECT id FROM evaluaciones WHERE profesor_id = ?', [u[0].profesor_id]);
            if (asigs.length > 0 || evals.length > 0) {
                return res.status(400).json({ error: "No se puede eliminar porque este profesor ya tiene asignaciones o evaluaciones registradas." });
            }
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
        const [usuariosProfeSinId] = await pool.query("SELECT id, nombre, email, carrera, nivel_asignado, password FROM usuarios WHERE rol = 'profesor' AND profesor_id IS NULL");
        for (const u of usuariosProfeSinId) {
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?)',
                [u.nombre, u.email || null, u.carrera || 'Ingeniería', u.nivel_asignado || 1, u.password || '123456']
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
        const { nombre, matricula, email, carrera, nivel_asignado, password } = req.body;
        if (!nombre || !password) {
            return res.status(400).json({ error: "El nombre y la contraseña son obligatorios" });
        }
        const nombreMayus = convertirMayusculas(nombre.trim());
        const emailVal = email ? email.trim().toLowerCase() : null;
        const areaCarrera = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const nivelAleatorio = Math.floor(Math.random() * 3) + 1;
        const nivel = (nivel_asignado !== undefined && nivel_asignado !== null && nivel_asignado !== '') 
            ? parseInt(nivel_asignado) 
            : nivelAleatorio;

        const query = 'INSERT INTO profesores (nombre, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?)';
        const [result] = await pool.query(query, [nombreMayus, emailVal, areaCarrera, nivel, password]);
        const profId = result.insertId;

        const matFinal = (matricula && matricula.trim()) ? matricula.trim() : `prof_${profId}`;
        const [uIns] = await pool.query(
            "INSERT INTO usuarios (nombre, matricula, email, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, 'profesor', ?, ?, ?)",
            [nombreMayus, matFinal, emailVal, password, areaCarrera, nivel, profId]
        );

        let infoCorreo = { enviado: false };
        if (emailVal) {
            infoCorreo = await enviarCorreoDatosCuenta({
                email: emailVal,
                nombre: nombreMayus,
                matricula: matFinal,
                password,
                rol: 'profesor',
                carrera: areaCarrera,
                nivel_asignado: nivel,
                baseUrl: obtenerUrlBase(req)
            });
        }

        const msgExtraCorreo = infoCorreo.enviado
            ? ` Se enviaron su usuario (${matFinal}), contraseña y enlace de acceso a ${emailVal}.`
            : '';

        res.json({
            id: profId,
            usuario_id: uIns.insertId,
            matricula: matFinal,
            correo_enviado: infoCorreo.enviado,
            enlace_acceso: infoCorreo.enlace_acceso,
            mensaje: `Profesor ${nombreMayus} registrado con éxito en ${areaCarrera} (Nivel ${nivel}).${msgExtraCorreo}`
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
            return res.status(400).json({ error: "Por favor ingresa tu usuario/correo y contraseña de profesor." });
        }

        // 1. Buscar en tabla usuarios (por matrícula, correo o nombre)
        const [uRows] = await pool.query(
            'SELECT id, nombre, matricula, email, password, rol, carrera, semestre, nivel_asignado, profesor_id FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR LOWER(TRIM(email)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?))',
            [idf, idf, idf]
        );

        if (uRows.length > 0 && uRows[0].password === pass) {
            const u = uRows[0];
            if (u.rol !== 'profesor') {
                return res.status(403).json({
                    error: "Este acceso es exclusivo para Maestros y Jueces Evaluadores. Si eres Alumno o Administrador, ingresa desde el acceso general."
                });
            }

            if (!u.profesor_id) {
                const [pIns] = await pool.query(
                    'INSERT INTO profesores (nombre, email, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?, ?)',
                    [u.nombre, u.email || null, u.carrera || 'Ingeniería', u.nivel_asignado || 1, u.password || '123456']
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

        // 2. Buscar en tabla profesores directamente (por nombre, correo o ID)
        const idParam = isNaN(idf) ? -1 : parseInt(idf);
        const [profes] = await pool.query(
            'SELECT id, nombre, email, carrera, nivel_asignado, password FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(?) OR LOWER(TRIM(email)) = LOWER(?) OR id = ?) AND password = ?',
            [idf, idf, idParam, pass]
        );

        if (profes.length > 0) {
            const p = profes[0];
            const [uCheck] = await pool.query('SELECT id, matricula, email, rol FROM usuarios WHERE profesor_id = ?', [p.id]);
            let uId = uCheck.length > 0 ? uCheck[0].id : null;
            let mat = uCheck.length > 0 ? uCheck[0].matricula : `prof_${p.id}`;
            if (!uId) {
                const [ins] = await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, email, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), mat, p.email || null, pass, p.carrera, p.nivel_asignado, p.id]
                );
                uId = ins.insertId;
            }
            const usuarioObj = {
                id: uId,
                nombre: p.nombre.toUpperCase(),
                matricula: mat,
                email: p.email || null,
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

        return res.status(401).json({ error: "Usuario/Correo o contraseña de profesor incorrectos." });
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
                ROUND(e.puntaje_total / 4.0, 2) as estrellas_otorgadas
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

// Asignar manualmente un cartel a un profesor juez (para pruebas o asignación directa)
app.post('/api/admin/asignaciones', async (req, res) => {
    try {
        const cartelId = parseInt(req.body.cartel_id);
        const profesorId = parseInt(req.body.profesor_id);

        if (!cartelId || !profesorId) {
            return res.status(400).json({ error: "Debes seleccionar un cartel y un profesor." });
        }

        const [cRows] = await pool.query('SELECT id, titulo_cartel FROM carteles WHERE id = ?', [cartelId]);
        if (cRows.length === 0) {
            return res.status(404).json({ error: "El cartel seleccionado no existe." });
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
            return res.status(400).json({ error: `El cartel "${cRows[0].titulo_cartel}" ya está asignado al profesor ${pRows[0].nombre}.` });
        }

        const [result] = await pool.query(
            'INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)',
            [cartelId, profesorId]
        );

        res.json({
            id: result.insertId,
            mensaje: `¡Cartel "${cRows[0].titulo_cartel}" asignado manualmente a ${pRows[0].nombre}!`
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

// Registrar nuevo cartel con asignación automática de clave y participantes (Nombres de alumnos en MAYÚSCULAS)
app.post('/api/carteles', upload.single('archivo_pdf'), async (req, res) => {
    try {
        const { nombre_equipo, participantes, carrera, semestre, titulo_cartel, profesor_asesor_id, usuario_id } = req.body;
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

        // Generar clave única automáticamente en el servidor
        let claveGenerada = generarClaveAleatoria();
        let existeClave = true;
        while (existeClave) {
            const [existentes] = await pool.query('SELECT id FROM carteles WHERE clave = ?', [claveGenerada]);
            if (existentes.length === 0) {
                existeClave = false;
            } else {
                claveGenerada = generarClaveAleatoria();
            }
        }

        const query = `INSERT INTO carteles (usuario_id, nombre_equipo, participantes, carrera, semestre, nivel, titulo_cartel, clave, archivo_url, profesor_asesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await pool.query(query, [usrId, equipoCap, participantesMayus, carrera, sem, nivel, tituloLimpio, claveGenerada, archivo_url, profesor_asesor_id || null]);

        res.json({ 
            id: result.insertId, 
            clave: claveGenerada,
            mensaje: `Cartel registrado con éxito en Nivel ${nivel}. Clave única asignada: ${claveGenerada}` 
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Repartir carteles entre profesores jueces
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

            if (candidatosValidos.length < 3) {
                throw new Error(
                    `El cartel "${cartel.titulo_cartel}" (Área: ${cartel.carrera}, Nivel ${cartel.nivel}) requiere mínimo 3 profesores jueces de su misma área y nivel. Disponibles actualmente: ${candidatosValidos.length}. Asigna o registra más profesores de ${cartel.carrera} en Nivel ${cartel.nivel}.`
                );
            }

            candidatosValidos.sort((a, b) => cargaProfesores[a.id] - cargaProfesores[b.id]);
            const asignados = candidatosValidos.slice(0, 3);

            for (const profe of asignados) {
                await connection.execute('INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)', [cartel.id, profe.id]);
                cargaProfesores[profe.id]++;
            }
        }

        await connection.commit();
        res.json({ mensaje: "¡Carteles repartidos exitosamente entre los profesores jueces!" });
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

// Evaluar por profesor asignado (Escala 1 a 5 estrellas en 4 rubros)
app.post('/api/evaluar', async (req, res) => {
    try {
        const { cartel_id, profesor_id, r1, r2, r3, r4 } = req.body;

        const valR1 = parseInt(r1);
        const valR2 = parseInt(r2);
        const valR3 = parseInt(r3);
        const valR4 = parseInt(r4);

        if ([valR1, valR2, valR3, valR4].some(v => isNaN(v) || v < 1 || v > 5)) {
            return res.status(400).json({ error: "Todos los rubros (Originalidad, Estética, Exposición y Vestimenta) deben calificarse con estrellas de 1 a 5." });
        }

        const [conteo] = await pool.query(`SELECT COUNT(*) as total FROM evaluaciones WHERE cartel_id = ?`, [cartel_id]);
        if (conteo[0].total >= 3) {
            return res.status(400).json({ error: "Este cartel ya cuenta con sus 3 evaluaciones completadas." });
        }

        // r5 se envía en 0 para satisfacer la estructura existente de evaluaciones
        const query = `INSERT INTO evaluaciones (cartel_id, profesor_id, r1, r2, r3, r4, r5) VALUES (?, ?, ?, ?, ?, ?, 0)`;
        await pool.query(query, [cartel_id, profesor_id, valR1, valR2, valR3, valR4]);

        res.json({ mensaje: "Evaluación registrada con éxito" });
    } catch (err) {
        res.status(400).json({ error: "Error o ya habías evaluado este cartel." });
    }
});

// Evaluar por Maestro Invitado mediante Clave (Exclusivo desde el Dashboard de Profesores/Jueces)
app.post('/api/evaluar-invitado', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { clave, nombre_maestro, suplir_profesor_id, r1, r2, r3, r4, usuario_id, profesor_id } = req.body;

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

        const valR1 = parseInt(r1);
        const valR2 = parseInt(r2);
        const valR3 = parseInt(r3);
        const valR4 = parseInt(r4);

        if ([valR1, valR2, valR3, valR4].some(v => isNaN(v) || v < 1 || v > 5)) {
            await connection.rollback();
            return res.status(400).json({ error: "Todos los rubros deben calificarse de 1 a 5 estrellas." });
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

        // Guardar la evaluación
        await connection.execute(
            'INSERT INTO evaluaciones (cartel_id, profesor_id, r1, r2, r3, r4, r5) VALUES (?, ?, ?, ?, ?, ?, 0)',
            [cartel.id, profesorId, valR1, valR2, valR3, valR4]
        );

        await connection.commit();
        res.json({ 
            mensaje: `¡Evaluación registrada exitosamente por ${nombreFormateado}!`,
            cartel_id: cartel.id
        });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// Ranking general por niveles con participantes, clave y promedio de estrellas
app.get('/api/dashboard/ranking', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.nivel, c.carrera, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                ROUND(AVG(e.puntaje_total), 2) as promedio_final,
                ROUND(AVG(e.puntaje_total) / 4.0, 2) as promedio_estrellas
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            GROUP BY c.id
            ORDER BY c.nivel ASC, promedio_final DESC
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));