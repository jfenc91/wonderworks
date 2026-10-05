import {request} from 'node:http';
// Connect inside the container while preserving the configured public Host.
// The HTTP client accepts an explicit Host even when the public URL uses TLS.
try {
  const req=request({hostname:'127.0.0.1',port:Number(process.env.WW_PORT??3000),path:'/health/ready',headers:{Host:new URL(process.env.WW_PUBLIC_URL).host},timeout:5000},res=>{res.resume();process.exitCode=res.statusCode===200?0:1;});
  req.on('timeout',()=>req.destroy());
  req.on('error',()=>{process.exitCode=1;});
  req.end();
} catch {process.exitCode=1;}
