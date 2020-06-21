var is = require('type-is')
var Busboy = require('busboy')
var extend = require('xtend')
var isUrl = require('is-url')
var onFinished = require('on-finished')
var appendField = require('append-field')
var {get} = require('request')

var Counter = require('./counter')
var MulterError = require('./multer-error')
var FileAppender = require('./file-appender')
var removeUploadedFiles = require('./remove-uploaded-files')

function drainStream (stream) {
  stream.on('readable', stream.read.bind(stream))
}

function makeMiddleware (setup) {
  return function multerMiddleware (req, res, next) {
    if (!is(req, ['multipart'])) return next()

    var options = setup()

    var limits = options.limits
    var storage = options.storage
    var compressPdf = options.compressPdf
    var fileFilter = options.fileFilter
    var fileStrategy = options.fileStrategy
    var preservePath = options.preservePath

    req.body = Object.create(null)

    var busboy

    try {
      busboy = new Busboy({ headers: req.headers, limits: limits, preservePath: preservePath })
    } catch (err) {
      return next(err)
    }

    var appender = new FileAppender(fileStrategy, req)
    var isDone = false
    var readFinished = false
    var errorOccured = false
    var pendingWrites = new Counter()
    var uploadedFiles = []
    var fileUploaded =  false;

    function done (err) {
      if (isDone) return
      isDone = true

      req.unpipe(busboy)
      drainStream(req)
      busboy.removeAllListeners()

      onFinished(req, function () { next(err) })
    }

    function indicateDone () {
      if (readFinished && pendingWrites.isZero() && !errorOccured) done()
    }

    function abortWithError (uploadError) {
      if (errorOccured) return
      errorOccured = true

      pendingWrites.onceZero(function () {
        function remove (file, cb) {
          storage._removeFile(req, file, cb)
        }

        removeUploadedFiles(uploadedFiles, remove, function (err, storageErrors) {
          if (err) return done(err)

          uploadError.storageErrors = storageErrors
          done(uploadError)
        })
      })
    }

    function abortWithCode (code, optionalField) {
      abortWithError(new MulterError(code, optionalField))
    }

    // handle text field data
    busboy.on('field', function (fieldname, value, fieldnameTruncated, valueTruncated) {
      // if (fieldnameTruncated) return abortWithCode('LIMIT_FIELD_KEY')
      // if (valueTruncated) return abortWithCode('LIMIT_FIELD_VALUE', fieldname)

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      // if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNameSize')) {
        // if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      // }

      appendField(req.body, fieldname, value)
    })

    // handle files
    busboy.on('file', function (fieldname, fileStream, filename, encoding, mimetype) {
      fileUploaded = true;
      // don't attach to the files object, if there is no file
      if (!filename) return fileStream.resume()

      // Work around bug in Busboy (https://github.com/mscdex/busboy/issues/6)
      if (limits && Object.prototype.hasOwnProperty.call(limits, 'fieldNameSize')) {
        if (fieldname.length > limits.fieldNameSize) return abortWithCode('LIMIT_FIELD_KEY')
      }

      var file = {
        fieldname: fieldname,
        originalname: filename,
        encoding: encoding,
        mimetype: mimetype
      }

      var placeholder = appender.insertPlaceholder(file)

      fileFilter(req, file, function (err, includeFile) {
        if (err) {
          appender.removePlaceholder(placeholder)
          return abortWithError(err)
        }

        if (!includeFile) {
          appender.removePlaceholder(placeholder)
          return fileStream.resume()
        }

        var aborting = false
        pendingWrites.increment()

        Object.defineProperty(file, 'stream', {
          configurable: true,
          enumerable: false,
          value: fileStream
        })

        fileStream.on('error', function (err) {
          pendingWrites.decrement()
          abortWithError(err)
        })

        fileStream.on('limit', function () {
          aborting = true
          abortWithCode('LIMIT_FILE_SIZE', fieldname)
        })

        storage._handleFile(req, file, function (err, info) {
          if (aborting) {
            appender.removePlaceholder(placeholder)
            uploadedFiles.push(extend(file, info))
            return pendingWrites.decrement()
          }

          if (err) {
            appender.removePlaceholder(placeholder)
            pendingWrites.decrement()
            return abortWithError(err)
          }

          if (file.mimetype === 'application/pdf' && info.size > 1000 * 1000 * 5) {
            // compress pdf and return path details
            compressPdf._handleCompress(opts = {}, req, info, function(err, data){
              if(err){
                appender.removePlaceholder(placeholder)
                pendingWrites.decrement()
                return abortWithError(err)                
              }

              var fileInfo = extend(file, data)

              appender.replacePlaceholder(placeholder, fileInfo)
              uploadedFiles.push(fileInfo)
              pendingWrites.decrement()
              indicateDone()               
            })

          }else{
            var fileInfo = extend(file, info)

            appender.replacePlaceholder(placeholder, fileInfo)
            uploadedFiles.push(fileInfo)
            pendingWrites.decrement()
            indicateDone()            
          }

        })
      })
    })

    busboy.on('error', function (err) { abortWithError(err) })
    busboy.on('partsLimit', function () { abortWithCode('LIMIT_PART_COUNT') })
    busboy.on('filesLimit', function () { abortWithCode('LIMIT_FILE_COUNT') })
    busboy.on('fieldsLimit', function () { abortWithCode('LIMIT_FIELD_COUNT') })
    busboy.on('finish', function () {
      if(!fileUploaded){
        console.log(fileUploaded, isDone)
        // check if upload fields contain file_url
        var {file_url} = req.body;
        if (!isUrl(file_url)) return abortWithError(new Error('Invalid file URL, check and try again!'))

        get(file_url, { encoding: null }, function(err, res, body) {
          if (err || res.statusCode !== 200) return abortWithError(new Error('File does not exist!'))

          // fieldname: fieldname,
          // originalname: filename,
          // encoding: encoding,
          // mimetype: mimetype

          var file = {
            mimetype: res.headers['content-type'],
            size: res.headers['content-length'],
            file: res.body
          }

          var placeholder = appender.insertPlaceholder(file)

          fileFilter(req, file, function (err, includeFile) {
            if (err) {
              appender.removePlaceholder(placeholder)
              return abortWithError(err)
            }
    
            if (!includeFile) {
              appender.removePlaceholder(placeholder)
            }

            if (file.mimetype === 'application/pdf' && file.size > 1000 * 1000 * 5) {

              compressPdf._handleCompress(opts = {}, req, info, function(err, data){
                if(err){
                  appender.removePlaceholder(placeholder)
                  pendingWrites.decrement()
                  return abortWithError(err)                
                }
  
                var fileInfo = extend(file, data)
  
                appender.replacePlaceholder(placeholder, fileInfo)
                uploadedFiles.push(fileInfo)
                pendingWrites.decrement()
                indicateDone()                 
              })

            }else{
              var fileInfo = extend(file, info)

              appender.replacePlaceholder(placeholder, fileInfo)
              uploadedFiles.push(fileInfo)
              pendingWrites.decrement()
              indicateDone()               
            }

          })

        }) 
      }else{
        readFinished = true
        indicateDone()
      }

    })

    req.pipe(busboy)
  }
}

module.exports = makeMiddleware
