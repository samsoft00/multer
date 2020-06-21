var diskStorage = require('../storage/disk')
var extend = require('xtend')
var intoStream = require('into-stream')
var { ensureFileSync } = require('fs-extra')
var gs = require('ghostscript4js')

function CompressPDF(options) {
  // buffer, fileExt,
  this.compressDest = ensureFileSync(`${options.dest}/compress`)
  this.diskStorage = diskStorage({ destination: options.dest })
}
// opts = {}, req, info
CompressPDF.prototype._handleCompress = function _handleCompress(
  opts,
  req,
  file,
  cb
) {
  var fileStream = intoStream(file.buffer);
  this.diskStorage._handleFile(req, fileStream, function (err, data) {
    if (err) {
      return cb(err)
    }

    // destination: destination,
    // filename: filename,
    // path: finalPath,
    // size: outStream.bytesWritten

    const inputFilePath = data.path
    const outputFilePath = this.compressDest

    try {
      var options = {
        "-psconv": "",
        "-sDEVICE": "pdfwrite",
        "-dCompatibilityLevel": 1.4,
        "-dDownsampleMonoImages": "false",
        "-dNOPAUSE": "",
        "-dQUIET": "",
        "-dBATCH": "",
        "-dDownsampleColorImages": "true",
        "-dDownsampleGrayImages": "true",
        "-dColorImageDownsampleThreshold": 1.0,
        "-dGrayImageDownsampleThreshold": 1.0,
        "-dMonoImageDownsampleThreshold": 1.0,
        "-dColorImageDownsampleType": "/Bicubic",
        "-dGrayImageDownsampleType": "/Bicubic",
        "-dColorImageResolution": 150,
        "-dGrayImageResolution": 150,
        "-dMonoImageResolution": 150,
        "-sOutputFile": outputFilePath,
        ...opts,
      };

      const command = Object.keys(options)
        .map((option) =>
          options[option] ? `${option}=${options[option]}` : option
        )
        .join(" ")
        .concat(` ${inputFilePath}`)

      const startTime = new Date()
      return gs
        .execute(command)
        .then(() => {
          cb(
            null,
            extend(
              {
                command: `gs ${command}`,
                time_taken: (new Date() - startTime) / 1000,
                output_path: outputFilePath,
                input_path: inputFilePath,
              },
              data
            )
          )
        })
        .catch((e) => {
          cb(e)
        });
    } catch (e) {
      cb(e)
    }
  });
};

module.exports = function (opts) {
  return new CompressPDF(opts)
};
