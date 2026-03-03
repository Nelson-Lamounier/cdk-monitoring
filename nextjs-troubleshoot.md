sh-5.2$ kubectl label node AppWorker role=application
Error from server (NotFound): nodes "AppWorker" not found
sh-5.2$ kubectl get nodes
NAME                                       STATUS   ROLES           AGE   VERSION
ip-10-0-0-160.eu-west-1.compute.internal   Ready    <none>          17h   v1.35.1
ip-10-0-0-169.eu-west-1.compute.internal   Ready    control-plane   17h   v1.35.1
ip-10-0-0-26.eu-west-1.compute.internal    Ready    <none>          17h   v1.35.1
sh-5.2$ kubectl get namespace nextjs-app
NAME         STATUS   AGE
nextjs-app   Active   17h
sh-5.2$ kubectl get all -n nextjs-app
NAME                          READY   STATUS    RESTARTS   AGE
pod/nextjs-64c7b5bddb-pdgk5   0/1     Pending   0          17h

NAME             TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
service/nextjs   ClusterIP   10.105.59.193   <none>        3000/TCP   17h

NAME                     READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/nextjs   0/1     1            0           17h

NAME                                DESIRED   CURRENT   READY   AGE
replicaset.apps/nextjs-64c7b5bddb   1         1         0       17h
sh-5.2$ kubectl get pods -n nextjs-app -o wide
NAME                      READY   STATUS    RESTARTS   AGE   IP       NODE     NOMINATED NODE   READINESS GATES
nextjs-64c7b5bddb-pdgk5   0/1     Pending   0          17h   <none>   <none>   <none>           <none>