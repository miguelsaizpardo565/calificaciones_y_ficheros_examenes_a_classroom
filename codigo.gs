// ================= CONFIGURACIÓN =================
const CONFIG = {
  // ID de la carpeta de Drive donde están los PDFs corregidos
  FOLDER_ID: '1iYq7BJQsC98ILEsuYZSUkeRLTPeShFOh',

  // ID del Curso en Classroom
  // economía 885316011366
  COURSE_ID: '885316011366',

  // Nombre de la tarea en Classroom
  EXAM_TITLE: 'Examen unidad 2. La organización económica',

  // Se asignará automáticamente en procesarExamenesIndependientes()
  COURSEWORK_ID: '',

  SHEET_ID: '1u0yePdIhGdZFVykZQ9DPSj5M7QgNXO2TE4d5TJKl8bY',
  SHEET_NAME: 'correos',
};

/**
 * FUNCIÓN PRINCIPAL: Obtiene/crea la tarea, asigna notas, protege el PDF original,
 * genera un PDF con el enlace y lo adjunta en Classroom.
 */
function main() {
  CONFIG.COURSEWORK_ID = createTarea();

  const alumnosMap = cargarMapaAlumnos();

  const submissionsResponse = Classroom.Courses.CourseWork.StudentSubmissions.list(
    CONFIG.COURSE_ID,
    CONFIG.COURSEWORK_ID
  );
  const submissions = submissionsResponse.studentSubmissions || [];

  const userToSubmissionMap = {};
  submissions.forEach(sub => {
    userToSubmissionMap[sub.userId] = sub;
  });

  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const linksFolder = CONFIG.LINKS_FOLDER_ID
    ? DriveApp.getFolderById(CONFIG.LINKS_FOLDER_ID)
    : folder;

  const files = folder.getFilesByType(MimeType.PDF);
  const currentUserEmail = Session.getActiveUser().getEmail();

  let procesados = 0;

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();

    // Evita reprocesar PDFs-enlace generados previamente en la misma carpeta
    if (fileName.startsWith('Enlace - ')) {
      continue;
    }

    // Ejemplo esperado: "Juan Pérez calificación 8.5 páginas 3.pdf"
    const match = fileName.match(/^(.+) calificaci.n ([0-9]+[.,]?[0-9]*) p.ginas [0-9]+\.pdf$/i);
    if (!match) {
      Logger.log(`⚠️ Formato de nombre no reconocido, se omite: ${fileName}`);
      continue;
    }

    const nombreArchivo = match[1].trim();
    const nota = parseFloat(match[2].replace(',', '.'));
    const alumnoInfo = alumnosMap[normalizarTexto(nombreArchivo)];

    if (!alumnoInfo) {
      Logger.log(`❌ No se encontró correo para: "${nombreArchivo}"`);
      continue;
    }

    try {
      const owner = file.getOwner();
      const ownerEmail = owner ? owner.getEmail() : null;
      if (ownerEmail && currentUserEmail && ownerEmail.toLowerCase() !== currentUserEmail.toLowerCase()) {
        throw new Error(`El archivo original "${fileName}" ya no pertenece a ${currentUserEmail} (propietario actual: ${ownerEmail}).`);
      }

      const userProfile = Classroom.UserProfiles.get(alumnoInfo.email);
      const submission = userToSubmissionMap[userProfile.id];

      if (!submission) {
        Logger.log(`❌ El alumno ${alumnoInfo.email} no tiene entrega asociada en esta tarea.`);
        continue;
      }

      // 1. Compartir el PDF original solo como lector y bloquear descarga/copia/impresión
      file.addViewer(alumnoInfo.email);
      Drive.Files.update(
        { copyRequiresWriterPermission: true },
        file.getId()
      );

      // 2. Asignar calificación
      Classroom.Courses.CourseWork.StudentSubmissions.patch(
        {
          draftGrade: nota,
          assignedGrade: nota
        },
        CONFIG.COURSE_ID,
        CONFIG.COURSEWORK_ID,
        submission.id,
        { updateMask: 'draftGrade,assignedGrade' }
      );

      // 3. Comprobar si ya existe un adjunto previo para no volver a adjuntar
      const existingAttachments =
        (submission.assignmentSubmission && submission.assignmentSubmission.attachments) || [];

      if (existingAttachments.length > 0) {
        Logger.log(`ℹ️ ${alumnoInfo.nombreOriginal} ya tiene adjunto en la entrega; se omite crear nuevo PDF-enlace.`);
      } else {
        const enlacePdfFile = crearPdfConEnlace(
          linksFolder,
          alumnoInfo.nombreOriginal,
          CONFIG.EXAM_TITLE,
          nota,
          file.getUrl()
        );

        Classroom.Courses.CourseWork.StudentSubmissions.modifyAttachments(
          {
            addAttachments: [
              {
                driveFile: {
                  id: enlacePdfFile.getId()
                }
              }
            ]
          },
          CONFIG.COURSE_ID,
          CONFIG.COURSEWORK_ID,
          submission.id
        );
      }

      Logger.log(`🔒✅ Procesado: ${alumnoInfo.nombreOriginal} | Nota: ${nota}`);
      procesados++;

    } catch (e) {
      Logger.log(`🔥 Error procesando a ${nombreArchivo}: ${e.message}`);
    }
  }

  Logger.log(`--- Proceso finalizado. Total de exámenes procesados: ${procesados} ---`);
}

/**
 * Busca una tarea con CONFIG.EXAM_TITLE en el curso y devuelve su ID.
 * Si no existe, la crea en estado PUBLISHED con puntuación máxima 10 y devuelve su ID.
 * Si existe pero no está publicada, la publica.
 */
function createTarea() {
  const tituloBuscado = normalizarTexto(CONFIG.EXAM_TITLE);
  let pageToken = null;

  do {
    const response = Classroom.Courses.CourseWork.list(CONFIG.COURSE_ID, {
      pageToken: pageToken,
      courseWorkStates: ['PUBLISHED', 'DRAFT']
    });

    const courseWorks = response.courseWork || [];
    for (let i = 0; i < courseWorks.length; i++) {
      const tarea = courseWorks[i];
      if (normalizarTexto(tarea.title) === tituloBuscado) {
        if (tarea.state !== 'PUBLISHED') {
          Classroom.Courses.CourseWork.patch(
            { state: 'PUBLISHED' },
            CONFIG.COURSE_ID,
            tarea.id,
            { updateMask: 'state' }
          );
          Logger.log(`📢 Tarea existente estaba en ${tarea.state} y se ha publicado: "${tarea.title}" | ID: ${tarea.id}`);
        } else {
          Logger.log(`ℹ️ Tarea existente ya publicada: "${tarea.title}" | ID: ${tarea.id}`);
        }
        return tarea.id;
      }
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  const nuevaTarea = Classroom.Courses.CourseWork.create(
    {
      title: CONFIG.EXAM_TITLE,
      maxPoints: 10,
      workType: 'ASSIGNMENT',
      assigneeMode: 'ALL_STUDENTS',
      state: 'PUBLISHED'
    },
    CONFIG.COURSE_ID
  );

  Logger.log(`✅ Tarea creada y publicada: "${nuevaTarea.title}" | ID: ${nuevaTarea.id}`);
  return nuevaTarea.id;
}


/**
 * Genera un PDF ligero con el enlace directo al examen original protegido.
 */
function crearPdfConEnlace(targetFolder, nombreAlumno, tituloExamen, nota, urlExamen) {
  const safeName = escaparHtml(nombreAlumno);
  const safeTitle = escaparHtml(tituloExamen);
  const safeUrl = escaparHtml(urlExamen);

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; margin: 36px; color: #222; line-height: 1.5; }
          .box { border: 1px solid #ccc; border-radius: 8px; padding: 24px; }
          h2 { margin-top: 0; color: #1a4b84; }
          .btn {
            display: inline-block;
            margin-top: 14px;
            padding: 10px 16px;
            background-color: #1a4b84;
            color: #ffffff;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
          }
          .url-text { margin-top: 14px; font-size: 12px; color: #555; word-break: break-all; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>${safeTitle}</h2>
          <p><strong>Alumno/a:</strong> ${safeName}</p>
          <p><strong>Calificación:</strong> ${nota}</p>
          <a class="btn" href="${safeUrl}">Abrir examen corregido</a>
          <p class="url-text">Enlace directo: <a href="${safeUrl}">${safeUrl}</a></p>
        </div>
      </body>
    </html>
  `;

  const pdfBlob = Utilities.newBlob(html, 'text/html', 'enlace.html')
    .getAs(MimeType.PDF)
    .setName(`Enlace - ${nombreAlumno} - ${tituloExamen}.pdf`);

  return targetFolder.createFile(pdfBlob);
}

/**
 * Busca la tarea definida en CONFIG.EXAM_TITLE dentro de CONFIG.COURSE_ID
 * y elimina todos los adjuntos de Drive de todas las entregas de alumnos.
 */
function limpiarTodosLosAdjuntosDeTarea() {
  const courseId = CONFIG.COURSE_ID;
  const courseWorkId = buscarIdTareaPorTitulo(courseId, CONFIG.EXAM_TITLE);

  if (!courseWorkId) {
    Logger.log(`⚠️ No se encontró ninguna tarea con el título "${CONFIG.EXAM_TITLE}" en el curso ${courseId}.`);
    return;
  }

  let pageToken = null;
  let totalEntregasRevisadas = 0;

  do {
    const response = Classroom.Courses.CourseWork.StudentSubmissions.list(
      courseId,
      courseWorkId,
      { pageToken: pageToken }
    );

    const submissions = response.studentSubmissions || [];
    for (let i = 0; i < submissions.length; i++) {
      limpiarAdjuntosEntrega(courseId, courseWorkId, submissions[i].id);
      totalEntregasRevisadas++;
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  Logger.log(`🧹 Limpieza completada para "${CONFIG.EXAM_TITLE}" (${courseWorkId}). Entregas revisadas: ${totalEntregasRevisadas}.`);
}

/**
 * Busca el ID de una tarea por título (normalizado) recorriendo páginas si hace falta.
 * Devuelve null si no existe.
 */
function buscarIdTareaPorTitulo(courseId, titulo) {
  const tituloBuscado = normalizarTexto(titulo);
  let pageToken = null;

  do {
    const response = Classroom.Courses.CourseWork.list(courseId, {
      pageToken: pageToken,
      courseWorkStates: ['PUBLISHED', 'DRAFT']
    });

    const courseWorks = response.courseWork || [];
    for (let i = 0; i < courseWorks.length; i++) {
      if (normalizarTexto(courseWorks[i].title) === tituloBuscado) {
        return courseWorks[i].id;
      }
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  return null;
}

/**
 * Elimina todos los adjuntos de Drive asociados a una entrega concreta.
 */
function limpiarAdjuntosEntrega(courseId, courseWorkId, submissionId) {
  const submission = Classroom.Courses.CourseWork.StudentSubmissions.get(
    courseId,
    courseWorkId,
    submissionId
  );

  const attachments =
    (submission.assignmentSubmission && submission.assignmentSubmission.attachments) || [];

  const driveFileIds = attachments
    .filter(att => att.driveFile && att.driveFile.id)
    .map(att => att.driveFile.id);

  if (driveFileIds.length > 0) {
    Classroom.Courses.CourseWork.StudentSubmissions.modifyAttachments(
      {
        removeAttachments: driveFileIds
      },
      courseId,
      courseWorkId,
      submissionId
    );
    Logger.log(`🗑️ Retirados ${driveFileIds.length} adjunto(s) de la entrega ${submissionId}`);
  }
}

function escaparHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Carga el mapa de alumnos desde la hoja indicada por SHEET_ID o desde ALUMNOS_DIRECTOS.
 */
function cargarMapaAlumnos() {
  const mapa = {};

  if (CONFIG.SHEET_ID && CONFIG.SHEET_ID !== 'PON_AQUI_EL_ID_DE_LA_HOJA_DE_CALCULO') {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const nombre = normalizarTexto(data[i][0]);
      const correo = String(data[i][1]).trim();
      if (nombre && correo) {
        mapa[nombre] = {
          email: correo,
          nombreOriginal: String(data[i][0]).trim()
        };
      }
    }
  } else {
    CONFIG.ALUMNOS_DIRECTOS.forEach(item => {
      const nombre = normalizarTexto(item.nombre);
      const correo = String(item.email).trim();
      if (nombre && correo) {
        mapa[nombre] = {
          email: correo,
          nombreOriginal: String(item.nombre).trim()
        };
      }
    });
  }

  return mapa;
}

function normalizarTexto(texto) {
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();
}