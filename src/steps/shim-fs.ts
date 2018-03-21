import { Stats } from 'fs'
import { ok } from 'assert'

const binary = (process as any).__nexe as NexeBinary
ok(binary)
const manifest = binary.resources
const directories: { [key: string]: { [key: string]: boolean } } = {}
const isString = (x: any): x is string => typeof x === 'string' || x instanceof String
const isNotFile = () => false
const isNotDirectory = isNotFile
const isFile = () => true
const noop = () => {}
const isDirectory = isFile

const fs = require('fs')
const path = require('path')

const originalExistsSync = fs.existsSync
const originalReadFile = fs.readFile
const originalReadFileSync = fs.readFileSync
const originalCreateReadStream = fs.createReadStream
const originalReaddir = fs.readdir
const originalReaddirSync = fs.readdirSync
const originalStatSync = fs.statSync
const originalStat = fs.stat
const originalRealpath = fs.realpath
const originalRealpathSync = fs.realpathSync
const resourceStart = binary.layout.resourceStart

let log = (text: string) => {
  if ((process.env.DEBUG || '').toLowerCase().includes('nexe:require')) {
    process.stderr.write('[nexe] - ' + text + '\n')
  } else {
    log = noop
  }
}

const statTime = function() {
  const stat = binary.layout.stat
  return {
    dev: 0,
    ino: 0,
    nlink: 0,
    rdev: 0,
    uid: 123,
    gid: 500,
    blksize: 4096,
    blocks: 0,
    atime: new Date(stat.atime),
    atimeMs: stat.atime.getTime(),
    mtime: new Date(stat.mtime),
    mtimeMs: stat.mtime.getTime(),
    ctime: new Date(stat.ctime),
    ctimMs: stat.ctime.getTime(),
    birthtime: new Date(stat.birthtime),
    birthtimeMs: stat.birthtime.getTime()
  }
}

const createStat = function(directoryExtensions: any, fileExtensions?: any) {
  if (!fileExtensions) {
    return Object.assign({}, binary.layout.stat, directoryExtensions, { size: 0 }, statTime())
  }
  const size = directoryExtensions[1]
  return Object.assign({}, binary.layout.stat, fileExtensions, { size }, statTime())
}

const ownStat = function(filepath: string) {
  const key = path.resolve(filepath)
  if (directories[key]) {
    return createStat({ isDirectory, isFile: isNotFile })
  }
  if (manifest[key]) {
    return createStat(manifest[key], { isFile, isDirectory: isNotDirectory })
  }
}

function makeLong(filepath: string) {
  return (path as any)._makeLong && (path as any)._makeLong(filepath)
}

let setupManifest = () => {
  Object.keys(manifest).forEach(key => {
    const entry = manifest[key]
    const absolutePath = path.resolve(key)
    const longPath = makeLong(absolutePath)
    const normalizedPath = path.normalize(key)

    if (!manifest[absolutePath]) {
      manifest[absolutePath] = entry
    }
    if (longPath && !manifest[longPath]) {
      manifest[longPath] = entry
    }
    if (!manifest[normalizedPath]) {
      manifest[normalizedPath] = manifest[key]
    }

    let currentDir = path.dirname(absolutePath)
    let prevDir = absolutePath

    while (currentDir !== prevDir) {
      directories[currentDir] = directories[currentDir] || {}
      directories[currentDir][path.basename(prevDir)] = true
      const longDir = makeLong(currentDir)
      if (longDir && !directories[longDir]) {
        directories[longDir] = directories[currentDir]
      }
      prevDir = currentDir
      currentDir = path.dirname(currentDir)
    }
  })
  setupManifest = noop
}

//naive patches intended to work for most use cases
const nfs: any = {
  existsSync: function existsSync(filepath: string) {
    const key = path.resolve(filepath)
    if (manifest[key] || directories[key]) {
      return true
    }
    return originalExistsSync.apply(fs, arguments)
  },
  realpath: function realpath(filepath: any, options: any, cb: any): void {
    setupManifest()
    if (isString(filepath) && manifest[filepath]) {
      return process.nextTick(() => cb(null, filepath))
    }
    return originalRealpath.call(fs, filepath, options, cb)
  },
  realpathSync: function realpathSync(filepath: any, options: any) {
    setupManifest()
    if (isString(filepath) && manifest[filepath]) {
      return filepath
    }
    return originalRealpathSync.call(fs, filepath, options)
  },
  readdir: function readdir(filepath: string | Buffer, options: any, callback: any) {
    setupManifest()
    filepath = filepath.toString()
    if ('function' === typeof options) {
      callback = options
      options = { encoding: 'utf8' }
    }
    const dir = directories[path.resolve(filepath)]
    if (dir) {
      process.nextTick(() => {
        //todo merge with original?
        callback(null, Object.keys(dir))
      })
    } else {
      return originalReaddir.apply(fs, arguments)
    }
  },

  readdirSync: function readdirSync(filepath: string | Buffer, options: any) {
    setupManifest()
    filepath = filepath.toString()
    const dir = directories[path.resolve(filepath)]
    if (dir) {
      return Object.keys(dir)
    }
    return originalReaddirSync.apply(fs, arguments)
  },

  readFile: function readFile(file: any, options: any, callback: any) {
    setupManifest()
    const entry = manifest[file] || manifest[path.resolve(file)]
    if (!entry || !isString(file)) {
      return originalReadFile.apply(fs, arguments)
    }
    const [offset, length] = entry
    const resourceOffset = resourceStart + offset
    const encoding = isString(options) ? options : null
    callback = typeof options === 'function' ? options : callback

    fs.open(process.execPath, 'r', function(err: Error, fd: number) {
      if (err) return callback(err, null)
      fs.read(fd, Buffer.alloc(length), 0, length, resourceOffset, function(
        error: Error,
        bytesRead: number,
        result: Buffer
      ) {
        if (error) {
          return fs.close(fd, function() {
            callback(error, null)
          })
        }
        fs.close(fd, function(err: Error) {
          if (err) {
            return callback(err, result)
          }
          callback(err, encoding ? result.toString(encoding) : result)
        })
      })
    })
  },
  createReadStream: function createReadStream(file: any, options: any) {
    setupManifest()
    const entry = manifest[file] || manifest[path.resolve(file)]
    if (!entry || !isString(file)) {
      return originalCreateReadStream.apply(fs, arguments)
    }
    const [offset, length] = entry
    const resourceOffset = resourceStart + offset
    const opts = !options ? {} : isString(options) ? { encoding: options } : options

    return fs.createReadStream(
      process.execPath,
      Object.assign({}, opts, {
        start: resourceOffset,
        end: resourceOffset + length
      })
    )
  },
  readFileSync: function readFileSync(file: any, options: any) {
    setupManifest()

    const entry = manifest[file] || manifest[path.resolve(file)]
    if (!entry || !isString(file)) {
      return originalReadFileSync.apply(fs, arguments)
    }
    const [offset, length] = entry
    const resourceOffset = resourceStart + offset
    const encoding = isString(options) ? options : null
    const fd = fs.openSync(process.execPath, 'r')
    const result = Buffer.alloc(length)
    fs.readSync(fd, result, 0, length, resourceOffset)
    fs.closeSync(fd)
    return encoding ? result.toString(encoding) : result
  },
  statSync: function statSync(filepath: string | Buffer) {
    const stat = isString(filepath) && ownStat(filepath)
    if (stat) {
      return stat
    }
    return originalStatSync.apply(fs, arguments)
  },
  stat: function stat(filepath: string | Buffer, callback: any) {
    const stat = isString(filepath) && ownStat(filepath)
    if (stat) {
      process.nextTick(() => {
        callback(null, stat)
      })
    } else {
      return originalStat.apply(fs, arguments)
    }
  }
}

if (typeof fs.exists === 'function') {
  nfs.exists = function(filepath: string, cb: Function) {
    cb = cb || noop
    const exists = nfs.existsSync(filepath)
    process.nextTick(() => cb(exists))
  }
}
Object.assign(fs, nfs)

const nexe    = (process as any).nexe
let patches   = {}
if(nexe) {
  patches     =  nexe.patches
}
delete (process as any).nexe

patches.internalModuleReadFile = function(this: any, original: any, ...args: any[]) {
  const [filepath] = args
  setupManifest()
  if (manifest[filepath]) {
    log('read     (hit)              ' + filepath)
    return nfs.readFileSync(filepath, 'utf-8')
  }
  log('read          (miss)       ' + filepath)
  return original.call(this, ...args)
}
patches.internalModuleStat = function(this: any, original: any, ...args: any[]) {
  setupManifest()
  const [filepath] = args
  if (manifest[filepath]) {
    log('stat     (hit)              ' + filepath + '   ' + 0)
    return 0
  }
  if (directories[filepath]) {
    log('stat dir (hit)              ' + filepath + '   ' + 1)
    return 1
  }
  const res = original.call(this, ...args)
  if (res === 0) {
    log('stat          (miss)        ' + filepath + '   ' + res)
  } else if (res === 1) {
    log('stat dir      (miss)        ' + filepath + '   ' + res)
  } else {
    log('stat                 (fail) ' + filepath + '   ' + res)
  }
  return res
}

interface NexeBinary {
  resources: { [key: string]: number[] }
  layout: {
    stat: Stats
    contentSize: number
    contentStart: number
    resourceSize: number
    resourceStart: number
  }
}
