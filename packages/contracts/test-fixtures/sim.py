import math
def sim(g, proc, fixed, mrate, n):
    days=[30*(i+1) for i in range(n)] if mrate else []
    comm=round(g*0.02,2)
    gc=g+comm
    avg=sum(mrate*d/30 for d in days)/n if mrate else 0
    after=gc/(1-avg)
    tot=(after+fixed)/(1-proc)
    return tot, comm, after-gc, tot-after
cases=[("Pix",0,1.99,0,1),("Cartão à vista",0.0299,0.49,0.0115,1),("Cartão 3x",0.0349,0.49,0.016,3),("Cartão 6x",0.0349,0.49,0.016,6),("Cartão 12x",0.0399,0.49,0.016,12)]
for g in (100,300,1000):
  for name,p,f,m,n in cases:
    t,c,a,pr=sim(g,p,f,m,n)
    print(f"{g}|{name}|{t:.2f}|{c:.2f}|{pr:.2f}|{a:.2f}|{t-g:.2f}|{(t-g)/g*100:.1f}%")
