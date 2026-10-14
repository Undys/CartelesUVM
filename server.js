const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

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

app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

    try {
        // 1. Columna carrera en profesores
        const [pCols] = await pool.query("SHOW COLUMNS FROM profesores LIKE 'carrera'");
        if (pCols.length === 0) {
            await pool.query("ALTER TABLE profesores ADD COLUMN carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería' AFTER nombre");
            console.log('Columna carrera agregada a profesores');
        }

        // 2. Columna participantes en carteles
        const [cPart] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'participantes'");
        if (cPart.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN participantes TEXT NULL AFTER nombre_equipo");
            console.log('Columna participantes agregada a carteles');
        }

        // 3. Columna clave en carteles
        const [cClave] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'clave'");
        if (cClave.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN clave VARCHAR(50) NULL AFTER titulo_cartel");
            console.log('Columna clave agregada a carteles');
        }

        // 4. Asegurar claves y participantes en carteles existentes
        const [existentes] = await pool.query("SELECT id, nombre_equipo, clave, participantes FROM carteles");
        for (const c of existentes) {
            const nuevaClave = c.clave || generarClaveAleatoria();
            const nuevosPart = (c.participantes || c.nombre_equipo || '').toUpperCase();
            await pool.query("UPDATE carteles SET clave = ?, participantes = ? WHERE id = ?", [nuevaClave, nuevosPart, c.id]);
        }

        // 5. Permitir r5 con default 0 en evaluaciones para el cálculo de 4 rubros
        try {
            await pool.query("ALTER TABLE evaluaciones MODIFY COLUMN r5 INT(11) DEFAULT 0");
        } catch (e) {
            console.warn('Modificación columna r5:', e.message);
        }

        // 6. Normalizar evaluaciones viejas a escala de 1 a 5 estrellas si existían de 0 a 20
        try {
            const [evalsAntiguas] = await pool.query("SELECT id, r1, r2, r3, r4 FROM evaluaciones WHERE r1 > 5 OR r2 > 5 OR r3 > 5 OR r4 > 5");
            for (const ev of evalsAntiguas) {
                const normR1 = Math.min(5, Math.max(1, Math.round(ev.r1 / 4)));
                const normR2 = Math.min(5, Math.max(1, Math.round(ev.r2 / 4)));
                const normR3 = Math.min(5, Math.max(1, Math.round(ev.r3 / 4)));
                const normR4 = Math.min(5, Math.max(1, Math.round(ev.r4 / 4)));
                await pool.query("UPDATE evaluaciones SET r1 = ?, r2 = ?, r3 = ?, r4 = ?, r5 = 0 WHERE id = ?", [normR1, normR2, normR3, normR4, ev.id]);
            }
        } catch (e) {
            console.warn('Normalización de evaluaciones:', e.message);
        }

        // 7. Capitalizar nombres existentes de profesores
        const [profes] = await pool.query("SELECT id, nombre FROM profesores");
        for (const p of profes) {
            const nombreCap = capitalizarNombre(p.nombre);
            if (nombreCap !== p.nombre) {
                await pool.query("UPDATE profesores SET nombre = ? WHERE id = ?", [nombreCap, p.id]);
            }
        }

        // 8. Tabla general de usuarios (alumnos, profesores y administradores)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(250) NOT NULL,
                matricula VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                rol ENUM('estudiante', 'profesor', 'admin') NOT NULL DEFAULT 'estudiante',
                carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería',
                semestre INT DEFAULT 1,
                nivel_asignado INT DEFAULT 1,
                profesor_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);

        // 9. Columna usuario_id en carteles para relacionar al alumno creador
        const [uCols] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'usuario_id'");
        if (uCols.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN usuario_id INT NULL AFTER id");
            console.log('Columna usuario_id agregada a carteles');
        }

        // 10. Sincronizar profesores existentes en la tabla usuarios si aún no están
        const [todosProfes] = await pool.query("SELECT * FROM profesores");
        for (const p of todosProfes) {
            const mat = 'prof_' + p.id;
            const [uExist] = await pool.query("SELECT id FROM usuarios WHERE profesor_id = ? OR matricula = ?", [p.id, mat]);
            if (uExist.length === 0) {
                await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), mat, p.password || '123456', p.carrera || 'Ingeniería', p.nivel_asignado || 1, p.id]
                );
            }
        }

        // 11. Asegurar la existencia de al menos un administrador sin contraseñas fijas en el código
        const [adminsExist] = await pool.query("SELECT id, matricula FROM usuarios WHERE rol = 'admin'");
        const adminUserEnv = (process.env.ADMIN_USER || 'admin').trim();
        const adminPassEnv = process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : null;

        if (adminsExist.length === 0) {
            if (adminPassEnv) {
                await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado) VALUES ('ADMINISTRADOR GENERAL', ?, ?, 'admin', 'General', 1)",
                    [adminUserEnv, adminPassEnv]
                );
                console.log(`[OK] Administrador inicial '${adminUserEnv}' configurado desde variables de entorno (.env).`);
            } else {
                const passAleatoria = 'Admin_' + crypto.randomBytes(4).toString('hex');
                await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado) VALUES ('ADMINISTRADOR GENERAL', ?, ?, 'admin', 'General', 1)",
                    [adminUserEnv, passAleatoria]
                );
                console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
                console.log('║ [SEGURIDAD] Administrador inicial generado (sin contraseña en el código):  ║');
                console.log(`║    Usuario:    ${adminUserEnv.padEnd(58)}║`);
                console.log(`║    Contraseña: ${passAleatoria.padEnd(58)}║`);
                console.log('║                                                                            ║');
                console.log('║ [INFO] Para definir tu propia contraseña sin exponerla en GitHub:          ║');
                console.log('║    Crea un archivo .env con: ADMIN_PASSWORD=TuContraseñaSecreta            ║');
                console.log('║    (El archivo .env está protegido por .gitignore y nunca se sube a GitHub)║');
                console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');
            }
        } else if (adminPassEnv) {
            // Sincronizar contraseña si fue establecida explícitamente en .env
            await pool.query(
                "UPDATE usuarios SET password = ? WHERE (matricula = ? OR id = ?) AND rol = 'admin'",
                [adminPassEnv, adminUserEnv, adminsExist[0].id]
            );
            console.log(`[OK] Contraseña del administrador '${adminUserEnv}' sincronizada desde .env.`);
        }

        // 12. Asegurar que participantes en carteles estén en MAYÚSCULAS
        const [cartelesMayus] = await pool.query("SELECT id, participantes FROM carteles WHERE participantes IS NOT NULL");
        for (const c of cartelesMayus) {
            if (c.participantes && c.participantes !== c.participantes.toUpperCase()) {
                await pool.query("UPDATE carteles SET participantes = ? WHERE id = ?", [c.participantes.toUpperCase(), c.id]);
            }
        }

        console.log('[OK] Esquema y datos actualizados correctamente.');
    } catch (e) {
        console.warn('Verificación de esquema BD:', e.message);
    }
}
conectarBD();

// --- ENDPOINTS AUTENTICACIÓN Y GESTIÓN DE USUARIOS ---

// Registro general de alumnos / usuarios (Por defecto con rol 'estudiante' y nombre en MAYÚSCULAS)
app.post('/api/registro', async (req, res) => {
    try {
        const { nombre, matricula, password, carrera, semestre } = req.body;
        
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre completo, matrícula/usuario y contraseña son obligatorios." });
        }

        // Requerimiento: todas las letras se hacen mayúsculas (ej. gabriel guerrero -> GABRIEL GUERRERO)
        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
        const pass = password.trim();
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;

        // Verificar si la matrícula o usuario ya existe
        const [existente] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);
        if (existente.length > 0) {
            return res.status(400).json({ error: "Esa matrícula o usuario ya se encuentra registrado." });
        }

        // Requerimiento: cada persona que se de de alta entra como estudiante
        const [result] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, password, rol, carrera, semestre) VALUES (?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, pass, 'estudiante', carreraVal, semVal]
        );

        res.json({
            mensaje: `¡Estudiante ${nombreMayus} registrado con éxito!`,
            usuario: {
                id: result.insertId,
                nombre: nombreMayus,
                matricula: mat,
                rol: 'estudiante',
                carrera: carreraVal,
                semestre: semVal
            }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Login general (para Alumnos, Profesores/Jueces y Administradores)
app.post('/api/login', async (req, res) => {
    try {
        const idf = (req.body.usuario || req.body.identificador || req.body.matricula || '').trim();
        const pass = (req.body.password || '').trim();

        if (!idf || !pass) {
            return res.status(400).json({ error: "Ingresa tu usuario/matrícula y contraseña." });
        }

        // 1. Buscar en tabla usuarios
        const [rows] = await pool.query(
            'SELECT id, nombre, matricula, password, rol, carrera, semestre, nivel_asignado, profesor_id FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?))',
            [idf, idf]
        );

        if (rows.length > 0 && rows[0].password === pass) {
            const u = rows[0];
            delete u.password;
            return res.json({ mensaje: "Acceso correcto", usuario: u });
        }

        // 2. Si no coincide, verificar si es admin en tabla legacy administradores (si existe)
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

        // 3. Verificar si es un profesor registrado en la tabla profesores directamente
        const [profes] = await pool.query(
            'SELECT id, nombre, carrera, nivel_asignado, password FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(?) OR id = ?) AND password = ?',
            [idf, isNaN(idf) ? -1 : parseInt(idf), pass]
        );

        if (profes.length > 0) {
            const p = profes[0];
            // Asegurar que exista en usuarios
            const [uCheck] = await pool.query('SELECT id, rol FROM usuarios WHERE profesor_id = ?', [p.id]);
            let uId = uCheck.length > 0 ? uCheck[0].id : null;
            if (!uId) {
                const [ins] = await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), `prof_${p.id}`, pass, p.carrera, p.nivel_asignado, p.id]
                );
                uId = ins.insertId;
            }
            return res.json({
                mensaje: "Acceso concedido como Profesor Juez",
                usuario: {
                    id: uId,
                    nombre: p.nombre.toUpperCase(),
                    matricula: `prof_${p.id}`,
                    rol: 'profesor',
                    carrera: p.carrera,
                    nivel_asignado: p.nivel_asignado,
                    profesor_id: p.id
                }
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

// Listar todos los usuarios para el Admin (Alumnos, Profesores y Admins)
app.get('/api/admin/usuarios', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT id, nombre, matricula, rol, carrera, semestre, nivel_asignado, profesor_id, created_at
            FROM usuarios
            ORDER BY 
                CASE rol WHEN 'admin' THEN 1 WHEN 'profesor' THEN 2 ELSE 3 END,
                nombre ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin da de alta a un usuario manualmente (eligiendo si es estudiante o profesor)
app.post('/api/admin/usuarios', async (req, res) => {
    try {
        const { nombre, matricula, password, rol, carrera, semestre, nivel_asignado } = req.body;
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre, usuario/matrícula y contraseña son obligatorios." });
        }

        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
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
                'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)',
                [nombreMayus, carreraVal, nivelVal, password]
            );
            profId = pIns.insertId;
        }

        const [uIns] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, password, rol, carrera, semestre, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, password, rolVal, carreraVal, semVal, nivelVal, profId]
        );

        res.json({
            mensaje: `Usuario ${nombreMayus} registrado como ${rolVal} exitosamente.`,
            usuario: { id: uIns.insertId, nombre: nombreMayus, matricula: mat, rol: rolVal, carrera: carreraVal, nivel_asignado: nivelVal, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin cambia el rol de un usuario (Promover a Profesor / Asignar como Estudiante)
// Admin cambia el rol de un usuario (Promover a Profesor / Asignar como Estudiante / Promover a Administrador)
app.put('/api/admin/usuarios/:id/rol', async (req, res) => {
    try {
        const { id } = req.params;
        const { rol, carrera, nivel_asignado, password } = req.body;

        const [userRows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (userRows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRows[0];

        const rolesValidos = ['estudiante', 'profesor', 'admin'];
        const nuevoRol = rolesValidos.includes(rol) ? rol : 'estudiante';
        const nuevaCarrera = (carrera && carrera.trim()) ? carrera.trim() : (nuevoRol === 'admin' ? 'General' : (user.carrera || 'Ingeniería'));
        const nuevoNivel = parseInt(nivel_asignado) || user.nivel_asignado || 1;
        const passActualizada = (password && password.trim()) ? password.trim() : user.password;

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
                    'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)',
                    [user.nombre, nuevaCarrera, nuevoNivel, passActualizada || '123456']
                );
                profId = pIns.insertId;
            } else {
                // Actualizar sus datos en profesores
                await pool.query(
                    'UPDATE profesores SET carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                    [nuevaCarrera, nuevoNivel, passActualizada, profId]
                );
            }
        } else if (profId && passActualizada !== user.password) {
            // Si se cambió la contraseña y tiene cuenta de profesor asociada
            await pool.query('UPDATE profesores SET password = ? WHERE id = ?', [passActualizada, profId]);
        }

        await pool.query(
            'UPDATE usuarios SET rol = ?, carrera = ?, nivel_asignado = ?, profesor_id = ?, password = ? WHERE id = ?',
            [nuevoRol, nuevaCarrera, nuevoNivel, profId, passActualizada, id]
        );

        const rolTexto = nuevoRol === 'admin' ? 'ADMINISTRADOR' : (nuevoRol === 'profesor' ? 'PROFESOR JUEZ' : 'ESTUDIANTE');

        res.json({
            mensaje: `¡Usuario ${user.nombre} ahora tiene el rol de ${rolTexto}!`,
            usuario: { ...user, rol: nuevoRol, carrera: nuevaCarrera, nivel_asignado: nuevoNivel, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Admin edita datos de un usuario
app.put('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, matricula, carrera, semestre, nivel_asignado, password, rol } = req.body;

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
        const car = carrera || user.carrera;
        const sem = semestre !== undefined ? parseInt(semestre) : user.semestre;
        const niv = nivel_asignado !== undefined ? parseInt(nivel_asignado) : user.nivel_asignado;
        const pass = (password && password.trim()) ? password.trim() : user.password;

        await pool.query(
            'UPDATE usuarios SET nombre = ?, matricula = ?, carrera = ?, semestre = ?, nivel_asignado = ?, password = ?, rol = ? WHERE id = ?',
            [nombreMayus, mat, car, sem, niv, pass, rolFinal, id]
        );

        if (user.profesor_id) {
            await pool.query(
                'UPDATE profesores SET nombre = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                [nombreMayus, car, niv, pass, user.profesor_id]
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
        const [rows] = await pool.query('SELECT id, nombre, carrera, nivel_asignado FROM profesores ORDER BY nombre ASC');
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/profesores', async (req, res) => {
    try {
        const { nombre, carrera, nivel_asignado, password } = req.body;
        if (!nombre || !password) {
            return res.status(400).json({ error: "El nombre y la contraseña son obligatorios" });
        }
        const nombreCap = capitalizarNombre(nombre.trim());
        const areaCarrera = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const nivelAleatorio = Math.floor(Math.random() * 3) + 1;
        const nivel = (nivel_asignado !== undefined && nivel_asignado !== null && nivel_asignado !== '') 
            ? parseInt(nivel_asignado) 
            : nivelAleatorio;

        const query = 'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)';
        const [result] = await pool.query(query, [nombreCap, areaCarrera, nivel, password]);
        res.json({ id: result.insertId, mensaje: `Profesor ${nombreCap} registrado con éxito en ${areaCarrera} (Asignado aleatoriamente a Nivel ${nivel}).` });
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

app.post('/api/login/profesor', async (req, res) => {
    try {
        const usuario = req.body.usuario || req.body.nombre || req.body.profesor_id;
        const password = req.body.password;

        if (!usuario || !password) {
            return res.status(400).json({ error: "Por favor ingresa usuario y contraseña" });
        }

        const idParam = isNaN(usuario) ? -1 : parseInt(usuario);
        const [rows] = await pool.query(
            'SELECT id, nombre, carrera, nivel_asignado FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(TRIM(?)) OR id = ?) AND password = ?', 
            [usuario, idParam, password]
        );

        if (rows.length === 0) return res.status(401).json({ error: "Contraseña incorrecta o usuario no encontrado" });
        res.json(rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- CARTELES, CLAVES Y EVALUACIONES ---

// Obtener lista completa de carteles para administración
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
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});



// Obtener detalles de un cartel por su clave (para maestros invitados o búsqueda rápida)
app.get('/api/carteles/clave/:clave', async (req, res) => {
    try {
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

// Evaluar por Maestro Invitado mediante Clave (Toma el lugar de un profesor ausente)
app.post('/api/evaluar-invitado', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { clave, nombre_maestro, suplir_profesor_id, r1, r2, r3, r4 } = req.body;

        if (!clave || !nombre_maestro || !nombre_maestro.trim()) {
            await connection.rollback();
            return res.status(400).json({ error: "La clave del cartel y tu nombre como Maestro Invitado son requeridos." });
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