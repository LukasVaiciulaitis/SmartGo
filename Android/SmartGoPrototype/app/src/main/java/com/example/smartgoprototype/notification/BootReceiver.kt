package com.example.smartgoprototype.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Reschedules departure alarms after a device reboot.
 * AlarmManager alarms do not survive reboots — this receiver restores them
 * by reading the cached routes from Room and re-scheduling via NotificationScheduler.
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var routeRepository: RouteRepository
    @Inject lateinit var notificationScheduler: NotificationScheduler

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val routes = routeRepository.observeRoutes().first()
                notificationScheduler.scheduleAll(routes)
            } finally {
                pending.finish()
            }
        }
    }
}
